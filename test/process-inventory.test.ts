import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { handler } from '../lambda/process-inventory';

const ddbMock = mockClient(DynamoDBDocumentClient);
beforeEach(() => ddbMock.reset());

// Build an SQS event whose body is the EventBridge envelope EventBridge->SQS delivers.
const sqsEvent = (detail: any) =>
  ({
    Records: [
      { messageId: 'm1', body: JSON.stringify({ 'detail-type': 'OrderPlaced', source: 'orders.api', detail }) },
    ],
  } as any);

test('decrements stock per item and records inventory status', async () => {
  ddbMock.on(UpdateCommand).resolves({});
  ddbMock.on(PutCommand).resolves({});

  await handler(sqsEvent({
    orderId: 'o-1',
    items: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 1 }],
    customerEmail: 'x@y.com',
    placedAt: '2026-07-22T00:00:00Z',
  }));

  const updates = ddbMock.commandCalls(UpdateCommand);
  expect(updates).toHaveLength(2);
  expect(updates[0].args[0].input.Key).toEqual({ PK: 'PRODUCT#A', SK: 'STOCK' });
  expect(updates[0].args[0].input.ExpressionAttributeValues).toMatchObject({ ':neg': -2 });

  const puts = ddbMock.commandCalls(PutCommand);
  expect(puts).toHaveLength(1);
  expect(puts[0].args[0].input.Item).toMatchObject({
    PK: 'ORDER#o-1',
    SK: 'STATUS#inventory',
    status: 'reserved',
  });
});

test('throws on a forceFailure order (poison → DLQ) and writes nothing', async () => {
  await expect(
    handler(sqsEvent({
      orderId: 'o-2',
      items: [{ sku: 'A', qty: 1 }],
      customerEmail: 'x@y.com',
      placedAt: '2026-07-22T00:00:00Z',
      forceFailure: true,
    })),
  ).rejects.toThrow(/Forced failure/);

  expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
});

test('skips a malformed message without writing', async () => {
  // The guard logs on purpose. Silence it so output stays clean, and assert it fired.
  const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  await handler(sqsEvent({ customerEmail: 'x@y.com' }));
  expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  expect(errSpy).toHaveBeenCalledTimes(1);
  errSpy.mockRestore();
});
