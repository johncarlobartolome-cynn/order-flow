import { mockClient } from 'aws-sdk-client-mock';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { handler } from '../lambda/create-order';

const ebMock = mockClient(EventBridgeClient);

beforeEach(() => {
  ebMock.reset();
  process.env.EVENT_BUS_NAME = 'order-flow-bus';
});

const apiEvent = (body: unknown) =>
  ({ body: body === undefined ? undefined : JSON.stringify(body) } as any);

test('publishes OrderPlaced and returns 202 with an orderId', async () => {
  ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [{ EventId: 'e1' }] });

  const res: any = await handler(apiEvent({
    items: [{ sku: 'ABC', qty: 2 }],
    customerEmail: 'buyer@example.com',
  }));

  expect(res.statusCode).toBe(202);
  const out = JSON.parse(res.body);
  expect(out.orderId).toBeDefined();

  const calls = ebMock.commandCalls(PutEventsCommand);
  expect(calls).toHaveLength(1);
  const entry = calls[0].args[0].input.Entries![0];
  expect(entry.Source).toBe('orders.api');
  expect(entry.DetailType).toBe('OrderPlaced');
  expect(entry.EventBusName).toBe('order-flow-bus');
  const detail = JSON.parse(entry.Detail!);
  expect(detail.items).toEqual([{ sku: 'ABC', qty: 2 }]);
  expect(detail.orderId).toBe(out.orderId);
});

test('rejects an empty order with 400 and publishes nothing', async () => {
  const res: any = await handler(apiEvent({ items: [], customerEmail: 'x@y.com' }));
  expect(res.statusCode).toBe(400);
  expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
});

test('rejects invalid JSON with 400', async () => {
  const res: any = await handler({ body: '{not json' } as any);
  expect(res.statusCode).toBe(400);
});
