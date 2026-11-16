// Example: call this from your website's checkout (server-side) after payment succeeds.
// STOCK_URL=http://localhost:3000 STOCK_WRITE_KEY=sk_... node examples/place-order.js
const STOCK_URL = process.env.STOCK_URL || 'http://localhost:3000';
const KEY = process.env.STOCK_WRITE_KEY;

async function reserveStock(orderId, items) {
  const res = await fetch(`${STOCK_URL}/api/v1/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ order_id: orderId, items }),
  });
  const data = await res.json();
  if (res.status === 409) throw new Error(`Out of stock: ${data.details.sku} (only ${data.details.available} left)`);
  if (!res.ok) throw new Error(data.error);
  return data.order;
}

reserveStock('ORDER-' + Date.now(), [{ sku: 'MUG', quantity: 1 }])
  .then((o) => console.log('Stock deducted for', o))
  .catch((e) => console.error(e.message));
