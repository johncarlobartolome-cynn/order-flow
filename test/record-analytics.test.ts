import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { handler } from '../lambda/record-analytics';

const ddbMock = mockClient(DynamoDBDocumentClient);
beforeEach(() => ddbMock.reset());

const orderEvent = (detail: any) =>
  ({ 'detail-type': 'OrderPlaced', source: 'orders.api', detail } as any);

test('records analytics totals for the order', async () => {
  ddbMock.on(PutCommand).resolves({});

  await handler(orderEvent({
    orderId: 'o-2',
    items: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 3 }],
    customerEmail: 'x@y.com',
    placedAt: '2026-07-22T00:00:00Z',
  }));

  const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item;
  expect(item).toMatchObject({
    PK: 'ORDER#o-2',
    SK: 'STATUS#analytics',
    status: 'recorded',
    itemCount: 2,
    totalQty: 5,
  });
});
