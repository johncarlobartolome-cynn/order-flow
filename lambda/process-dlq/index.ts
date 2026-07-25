import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME ?? '';

// The DLQ carries the SAME message shape the worker saw: an EventBridge
// envelope in the SQS body, with the order under `.detail`.
export const handler = async (event: SQSEvent): Promise<void> => {
  for (const record of event.Records) {
    await recordDeadLetter(record);
  }
};

async function recordDeadLetter(record: SQSRecord): Promise<void> {
  const order = JSON.parse(record.body)?.detail;
  if (!order?.orderId) {
    console.error('DLQ message with no orderId', { messageId: record.messageId });
    return; // nothing to signal against
  }

  // Terminal state, so a plain Put is naturally idempotent: a redelivery just
  // rewrites the same 'dead-letter' row. No condition needed (unlike the worker,
  // which guards against double-decrementing stock). And the worker never wrote
  // a STATUS#inventory row for a failed order (it throws before any write), so
  // there is nothing to clobber here.
  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `ORDER#${order.orderId}`,
        SK: 'STATUS#inventory',
        status: 'dead-letter',
        reason: 'exhausted retries, routed to DLQ',
        updatedAt: new Date().toISOString(),
      },
    }),
  );
  console.log(`Recorded dead-letter for order ${order.orderId}`);
}
