import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { randomUUID } from 'node:crypto';

const eventBridge = new EventBridgeClient({});

interface OrderItem {
  sku: string;
  qty: number;
}

type Validated =
  | { ok: true; items: OrderItem[]; customerEmail: string; forceFailure: boolean }
  | { ok: false; error: string };

// Plain, explicit validation. No framework: you can see exactly what's rejected.
function validate(body: any): Validated {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be a JSON object' };
  const { items, customerEmail, forceFailure } = body;
  if (!Array.isArray(items) || items.length === 0) return { ok: false, error: 'items must be a non-empty array' };
  for (const it of items) {
    if (!it || typeof it.sku !== 'string' || !it.sku) return { ok: false, error: 'each item needs a sku' };
    if (typeof it.qty !== 'number' || it.qty <= 0) return { ok: false, error: 'each item needs qty > 0' };
  }
  if (typeof customerEmail !== 'string' || !customerEmail.includes('@')) {
    return { ok: false, error: 'customerEmail is required' };
  }
  return { ok: true, items, customerEmail, forceFailure: Boolean(forceFailure) };
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  let parsed: unknown;
  try {
    parsed = event.body ? JSON.parse(event.body) : null;
  } catch {
    return json(400, { error: 'invalid JSON body' });
  }

  const result = validate(parsed);
  if (!result.ok) return json(400, { error: result.error });

  const orderId = randomUUID();
  const detail = {
    orderId,
    items: result.items,
    customerEmail: result.customerEmail,
    placedAt: new Date().toISOString(),
    forceFailure: result.forceFailure, // used in E4 to force a DLQ failure on demand
  };

  // Read the bus name at call time (not module load) so it's set from the
  // live environment and stays testable.
  const busName = process.env.EVENT_BUS_NAME ?? '';

  // Hand the event to EventBridge. We don't know who consumes it, that's the point.
  await eventBridge.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: busName,
          Source: 'orders.api',
          DetailType: 'OrderPlaced',
          Detail: JSON.stringify(detail),
        },
      ],
    }),
  );

  // 202 Accepted: order taken; consumers process asynchronously.
  return json(202, { orderId });
};

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}
