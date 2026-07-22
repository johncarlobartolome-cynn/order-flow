import type { EventBridgeEvent } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

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

export const handler = async (
  event: EventBridgeEvent<'OrderPlaced', OrderPlaced>,
): Promise<void> => {
  const order = event.detail;

  // Guard a malformed event: retrying a bad shape never succeeds, so log + skip.
  if (!order?.orderId || !Array.isArray(order.items)) {
    console.error('Skipping malformed OrderPlaced event', { id: event.id });
    return;
  }

  const itemCount = order.items.length;
  const totalQty = order.items.reduce((sum, it) => sum + it.qty, 0);

  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `ORDER#${order.orderId}`,
        SK: 'STATUS#analytics',
        status: 'recorded',
        itemCount,
        totalQty,
        updatedAt: new Date().toISOString(),
      },
    }),
  );
};
