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
  if (!order?.orderId || !order.customerEmail) {
    console.error('Skipping malformed OrderPlaced event', { id: event.id });
    return;
  }

  // Mock "send email": a real system calls SES here. We just record that we did.
  const message = `Order ${order.orderId} confirmed for ${order.customerEmail}`;

  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `ORDER#${order.orderId}`,
        SK: 'STATUS#email',
        status: 'sent',
        to: order.customerEmail,
        message,
        updatedAt: new Date().toISOString(),
      },
    }),
  );
};
