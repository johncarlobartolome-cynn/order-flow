import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME ?? '';

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const orderId = event.pathParameters?.id;
  if (!orderId) return json(400, { error: 'missing order id' });

  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `ORDER#${orderId}`, ':sk': 'STATUS#' },
    }),
  );

  // Shape as { email: {...}, analytics: {...}, inventory: {...} } for the UI.
  const statuses: Record<string, unknown> = {};
  for (const item of res.Items ?? []) {
    statuses[String(item.SK).replace('STATUS#', '')] = item;
  }

  return json(200, { orderId, statuses });
};

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
