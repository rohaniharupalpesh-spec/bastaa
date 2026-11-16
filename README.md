# Stock Manager

A small, self-hosted inventory app that keeps your website's stock in sync.

- **Dashboard** — add products, adjust stock (+/−, set exact count), low-stock alerts, full movement history, CSV import/export.
- **Website sync, three ways** (use any mix):
  1. **Embed script** — paste one `<script>` tag; elements like `<span data-stock-sku="MUG">` show live stock ("12 in stock" / "Out of stock") and "Add to cart" buttons disable themselves when sold out. Updates live, no page reload.
  2. **REST API** — your checkout calls `POST /api/v1/orders` to deduct stock. All-or-nothing (never oversells), idempotent on `order_id` (safe to retry).
  3. **Webhooks** — Stock Manager POSTs signed events to your site whenever stock changes, so your own database stays current.

Runs on Node.js 22.5+ with a single dependency (Express). Data is stored in a SQLite file — nothing else to install.

## Quick start

```bash
npm install
cp .env.example .env        # then set ADMIN_PASSWORD and SESSION_SECRET
npm start                   # http://localhost:3000
```

1. Open the dashboard, sign in, add products (or **Import CSV**).
2. Go to **Website sync** → create a **Read** key (`pk_…`) for your pages and a **Write** key (`sk_…`) for your server.
3. Paste the embed snippet into your site and/or call the API from your checkout.

Try `examples/demo-shop.html` (put your read key in it) next to the dashboard to watch stock update live.

## Embed script

```html
<script src="https://stock.your-site.com/embed.js" data-key="pk_..." defer></script>

<span data-stock-sku="MUG"></span>                              <!-- "12 in stock" / "Only 2 left" / "Out of stock" -->
<span data-stock-sku="MUG" data-stock-format="number"></span>   <!-- "12" -->
<button data-stock-sku="MUG" data-stock-disable-when-out>Add to cart</button>
<div data-stock-sku="MUG" data-stock-hide-when-out>…</div>
```

Elements get `stock-in`, `stock-low` or `stock-out` classes for styling. Optional script attributes:
`data-text-in`, `data-text-low`, `data-text-out` (use `{n}` for the number), `data-poll-seconds`, `data-api`.
JavaScript API: `StockSync.get('MUG')`, `StockSync.on('change', (sku, s) => …)`, `StockSync.refresh()`.

## API reference (`/api/v1`)

Authenticate with `Authorization: Bearer <key>` (or `X-API-Key`). Read keys may also be passed as `?key=pk_…`.

| Method & path | Key | Description |
|---|---|---|
| `GET /products` | read | All active products (`?search=`, `?category=`, `?include_inactive=true`) |
| `GET /products/:sku` | read | One product |
| `GET /stock?skus=A,B` | read | Compact map `{ stock: { A: { quantity, in_stock, low_stock, price } } }` |
| `POST /availability` | read | `{ items: [{ sku, quantity }] }` → can the cart be fulfilled? |
| `GET /events` | read | Server-Sent Events stream of live stock changes |
| `POST /orders` | write | `{ order_id, items: [{ sku, quantity }] }` — deducts stock. `201` created, `200` duplicate retry, `409` insufficient stock (`details.sku`, `details.available`) |
| `POST /orders/:order_id/cancel` | write | Puts the order's stock back (idempotent) |
| `PATCH /products/:sku/stock` | write | `{ delta: -2 }` or `{ set: 40 }`, optional `reason` (`restock`, `sale`, `adjustment`, `return`, `cancel`, `import`, `damage`), `reference`, `note` |
| `POST /products/bulk` | write | Create/update products by SKU from your site's catalog: `{ products: [{ sku, name, price, quantity, … }] }` |

Errors are JSON: `{ "error": "message", "details": { … } }`.

## Webhooks

Add your endpoint under **Website sync → Webhooks**. Each event is a POST with JSON:

```json
{ "id": "evt_…", "event": "stock.updated", "created_at": "…",
  "data": { "product": { "sku": "MUG", "quantity": 7, "in_stock": true, "low_stock": false, … }, "previous_quantity": 8, "reason": "sale" } }
```

Events: `stock.updated`, `stock.low`, `stock.out`, `product.created`, `product.updated`, `product.deleted`, `order.placed`, `order.cancelled`.
Verify `X-Stock-Signature` = hex HMAC-SHA256 of the raw body using the webhook's signing secret — see `examples/webhook-receiver.js`.
Failed deliveries are retried 3 times with backoff.

## CSV format

Header row (case-insensitive): `sku,name,category,price,quantity,low_stock_threshold,active,description`.
Existing SKUs are updated (quantity is set to the CSV value); new SKUs are created.

## Platform notes

- **Custom site (PHP, Node, Python, …)** — use the embed for display and call `POST /api/v1/orders` after payment.
- **WordPress / Wix / Squarespace / Shopify pages** — paste the embed snippet into a custom HTML/code block for live stock display. To deduct stock automatically, point the platform's "order created" webhook/automation (or a Zapier/Make step) at `POST /api/v1/orders`.

## Deploying

Any host that runs Node works (VPS, Render, Railway, Fly.io…). Keep the `data/` folder on persistent storage.
In production set `SECURE_COOKIES=true`, a long `SESSION_SECRET`, `TRUST_PROXY=true` behind a proxy, and `ALLOWED_ORIGINS=https://your-site.com`.

## Development

```bash
npm run dev    # restart on changes
npm test       # API tests (incl. concurrent-order oversell check)
```
