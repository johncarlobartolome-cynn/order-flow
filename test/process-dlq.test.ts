import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { SQSEvent } from 'aws-lambda';
import { handler } from '../lambda/process-dlq/index';

const ddbMock = mockClient(DynamoDBDocumentClient);
beforeEach(() => ddbMock.reset());

const dlqEvent = (orderId: string): SQSEvent =>
  ({ Records: [{ messageId: 'm1', body: JSON.stringify({ detail: { orderId, items: [{ sku: 'SKU-1', qty: 1 }] } }) }] } as any);

test('writes a dead-letter status row for a DLQ message', async () => {
  ddbMock.on(PutCommand).resolves({});
  await handler(dlqEvent('order-123'));
  const puts = ddbMock.commandCalls(PutCommand);
  expect(puts).toHaveLength(1);
  expect(puts[0].args[0].input.Item).toMatchObject({ PK: 'ORDER#order-123', SK: 'STATUS#inventory', status: 'dead-letter' });
});

test('skips a malformed DLQ message without writing', async () => {
  await handler({ Records: [{ messageId: 'm2', body: '{}' }] } as any);
  expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
});
