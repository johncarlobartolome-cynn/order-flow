import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { handler } from '../lambda/get-order-status';

const ddbMock = mockClient(DynamoDBDocumentClient);
beforeEach(() => ddbMock.reset());

const evt = (id?: string) => ({ pathParameters: id ? { id } : undefined } as any);

test('returns per-consumer statuses for an order', async () => {
  ddbMock.on(QueryCommand).resolves({
    Items: [
      { PK: 'ORDER#o1', SK: 'STATUS#email', status: 'sent' },
      { PK: 'ORDER#o1', SK: 'STATUS#inventory', status: 'reserved' },
    ],
  });

  const res: any = await handler(evt('o1'));
  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body);
  expect(body.orderId).toBe('o1');
  expect(body.statuses.email.status).toBe('sent');
  expect(body.statuses.inventory.status).toBe('reserved');
});

test('400 when id is missing', async () => {
  const res: any = await handler(evt());
  expect(res.statusCode).toBe(400);
  expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
});
