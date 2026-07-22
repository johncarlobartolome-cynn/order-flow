import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { handler } from '../lambda/notify-email';

const ddbMock = mockClient(DynamoDBDocumentClient);
beforeEach(() => ddbMock.reset());

const orderEvent = (detail: any) =>
  ({ 'detail-type': 'OrderPlaced', source: 'orders.api', detail } as any);

test('records an email status item for the order', async () => {
  ddbMock.on(PutCommand).resolves({});

  await handler(orderEvent({
    orderId: 'o-1',
    items: [{ sku: 'ABC', qty: 2 }],
    customerEmail: 'buyer@example.com',
    placedAt: '2026-07-22T00:00:00Z',
  }));

  const calls = ddbMock.commandCalls(PutCommand);
  expect(calls).toHaveLength(1);
  const input = calls[0].args[0].input;
  expect(input.TableName).toBe('order-flow-table');
  expect(input.Item).toMatchObject({
    PK: 'ORDER#o-1',
    SK: 'STATUS#email',
    status: 'sent',
    to: 'buyer@example.com',
  });
});

test('skips a malformed event without writing', async () => {
  ddbMock.on(PutCommand).resolves({});
  await handler(orderEvent({ customerEmail: 'x@y.com' })); // no orderId / items
  expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
});
