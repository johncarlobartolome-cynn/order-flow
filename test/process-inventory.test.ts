import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { handler } from '../lambda/process-inventory';

const ddbMock = mockClient(DynamoDBDocumentClient);
beforeEach(() => ddbMock.reset());

const sqsEvent = (detail: any) =>
  ({
    Records: [
      { messageId: 'm1', body: JSON.stringify({ 'detail-type': 'OrderPlaced', source: 'orders.api', detail }) },
    ],
  } as any);

const order = (extra: any = {}) => ({
  orderId: 'o-1',
  items: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 1 }],
  customerEmail: 'x@y.com',
  placedAt: '2026-07-22T00:00:00Z',
  ...extra,
});

test('atomically records inventory + decrements stock (one conditional transaction)', async () => {
  ddbMock.on(TransactWriteCommand).resolves({});

  await handler(sqsEvent(order()));

  const calls = ddbMock.commandCalls(TransactWriteCommand);
  expect(calls).toHaveLength(1);
  const items = calls[0].args[0].input.TransactItems!;
  expect(items).toHaveLength(3); // conditional Put + 2 decrements

  expect(items[0].Put?.ConditionExpression).toContain('attribute_not_exists');
  expect(items[0].Put?.Item).toMatchObject({ PK: 'ORDER#o-1', SK: 'STATUS#inventory', status: 'reserved' });
  expect(items[1].Update?.Key).toEqual({ PK: 'PRODUCT#A', SK: 'STOCK' });
  expect(items[1].Update?.ExpressionAttributeValues).toMatchObject({ ':neg': -2 });
  expect(items[2].Update?.Key).toEqual({ PK: 'PRODUCT#B', SK: 'STOCK' });
  expect(items[2].Update?.ExpressionAttributeValues).toMatchObject({ ':neg': -1 });
});

test('is idempotent: a duplicate delivery (condition fails) is a no-op, not an error', async () => {
  const cancelled: any = new Error('transaction cancelled');
  cancelled.name = 'TransactionCanceledException';
  cancelled.CancellationReasons = [{ Code: 'ConditionalCheckFailed' }];
  ddbMock.on(TransactWriteCommand).rejects(cancelled);

  // Must NOT throw: the message should be deleted, not retried into the DLQ.
  await expect(handler(sqsEvent(order({ orderId: 'o-dup' })))).resolves.toBeUndefined();
});

test('rethrows a non-conditional transaction failure (→ retry → DLQ)', async () => {
  const throttled: any = new Error('throttled');
  throttled.name = 'TransactionCanceledException';
  throttled.CancellationReasons = [{ Code: 'None' }, { Code: 'ThrottlingError' }];
  ddbMock.on(TransactWriteCommand).rejects(throttled);

  await expect(handler(sqsEvent(order({ orderId: 'o-throttle' })))).rejects.toThrow();
});

test('throws on a forceFailure order (poison → DLQ) and writes nothing', async () => {
  ddbMock.on(TransactWriteCommand).resolves({});
  await expect(handler(sqsEvent(order({ orderId: 'o-2', forceFailure: true })))).rejects.toThrow(/Forced failure/);
  expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
});

test('skips a malformed message without writing', async () => {
  ddbMock.on(TransactWriteCommand).resolves({});
  await handler(sqsEvent({ customerEmail: 'x@y.com' }));
  expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
});
