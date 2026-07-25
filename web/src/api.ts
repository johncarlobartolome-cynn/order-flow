const API = import.meta.env.VITE_API_URL;
if (!API) throw new Error('VITE_API_URL is not set — build with the deployed API URL');

export interface OrderItem { sku: string; qty: number; }

export async function placeOrder(items: OrderItem[], customerEmail: string, forceFailure: boolean) {
  const res = await fetch(`${API}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items, customerEmail, forceFailure }),
  });
  if (!res.ok) throw new Error(`place order failed: ${res.status}`);
  return (await res.json()) as { orderId: string };
}

export async function getStatus(orderId: string) {
  const res = await fetch(`${API}/orders/${orderId}`);
  if (!res.ok) throw new Error(`status failed: ${res.status}`);
  return (await res.json()) as { orderId: string; statuses: Record<string, { status?: string }> };
}