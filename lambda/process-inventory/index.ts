import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME ?? '';

interface OrderItem {
  sku: string;
  qty: number;
}
interface OrderPlaced {
  orderId: string;
  items: OrderItem[];
  customerEmail: string;
  placedAt: string;
  forceFailure?: boolean;
}

export const handler = async (event: SQSEvent): Promise<void> => {
  for (const record of event.Records) {
    await processRecord(record);
  }
};

async function processRecord(record: SQSRecord): Promise<void> {
  // EventBridge -> SQS puts the whole event in the body; the order is in .detail.
  const order: OrderPlaced = JSON.parse(record.body).detail;

  if (!order?.orderId || !Array.isArray(order.items)) {
    console.error('Skipping malformed order', { messageId: record.messageId });
    return;
  }

  // Poison-message demo: forceFailure throws before any write → retries → DLQ.
  if (order.forceFailure) {
    throw new Error(`Forced failure for order ${order.orderId}`);
  }

  // Idempotent + atomic. One transaction:
  //   (1) record STATUS#inventory, but ONLY if it doesn't already exist, and
  //   (2) decrement stock per item.
  // A duplicate delivery fails the condition → the whole transaction aborts →
  // nothing is re-applied. Partial writes are impossible (all-or-nothing).
  const decrements = order.items.map((item) => ({
    Update: {
      TableName: TABLE_NAME,
      Key: { PK: `PRODUCT#${item.sku}`, SK: 'STOCK' },
      UpdateExpression: 'ADD stock :neg',
      ExpressionAttributeValues: { ':neg': -item.qty },
    },
  }));

  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: TABLE_NAME,
              Item: {
                PK: `ORDER#${order.orderId}`,
                SK: 'STATUS#inventory',
                status: 'reserved',
                skus: order.items.map((i) => i.sku),
                updatedAt: new Date().toISOString(),
              },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          ...decrements,
        ],
      }),
    );
  } catch (err: any) {
    // Condition failed on the status Put = already processed → idempotent no-op.
    if (
      err?.name === 'TransactionCanceledException' &&
      err?.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed'
    ) {
      console.log(`Order ${order.orderId} already processed, skipping`);
      return;
    }
    throw err; // real failure → retry → eventually DLQ
  }
}
