import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

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

  // Poison-message demo: a forceFailure order throws. After maxReceiveCount
  // retries, SQS moves it to the DLQ instead of losing it.
  if (order.forceFailure) {
    throw new Error(`Forced failure for order ${order.orderId}`);
  }

  // Atomic stock decrement per item (ADD a negative delta).
  for (const item of order.items) {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `PRODUCT#${item.sku}`, SK: 'STOCK' },
        UpdateExpression: 'ADD stock :neg',
        ExpressionAttributeValues: { ':neg': -item.qty },
      }),
    );
  }

  // Record that inventory processed this order.
  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `ORDER#${order.orderId}`,
        SK: 'STATUS#inventory',
        status: 'reserved',
        skus: order.items.map((i) => i.sku),
        updatedAt: new Date().toISOString(),
      },
    }),
  );
}
