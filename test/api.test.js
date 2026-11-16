'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { createApp } = require('../src/app');

let server, base, ctx, cookie, readKey, writeKey;
const received = [];
let hookServer, hookUrl;

async function req(method, path, { body, headers = {}, admin = false } = {}) {
  const h = { ...headers };
  if (admin) { h.Cookie = cookie; h['X-Requested-With'] = 'stock-dashboard'; }
  let payload = body;
  if (body && typeof body === 'object') { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + path, { method, headers: h, body: payload });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: ct.includes('json') ? await res.json() : await res.text() };
}
const auth = (k) => ({ Authorization: `Bearer ${k}` });

before(async () => {
  hookServer = http.createServer((rq, rs) => {
    let raw = ''; rq.on('data', (c) => (raw += c));
    rq.on('end', () => { received.push({ headers: rq.headers, raw, body: JSON.parse(raw) }); rs.end('ok'); });
  });
  await new Promise((r) => hookServer.listen(0, r));
  hookUrl = `http://127.0.0.1:${hookServer.address().port}/hook`;

  ctx = createApp({ dbFile: ':memory:', adminPassword: 'secret', sessionSecret: 'test', allowedOrigins: ['*'], webhookOptions: { retries: 1, log: {} } });
  server = ctx.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server.close(); hookServer.close(); });

test('admin login required and works', async () => {
  assert.equal((await req('GET', '/admin/api/products')).status, 401);
  assert.equal((await req('POST', '/admin/api/login', { body: { password: 'nope' } })).status, 401);
  const r = await req('POST', '/admin/api/login', { body: { password: 'secret' } });
  assert.equal(r.status, 200);
  cookie = r.headers.get('set-cookie').split(';')[0];
  assert.equal((await req('GET', '/admin/api/me', { admin: true })).status, 200);
});

test('dashboard writes require the CSRF header', async () => {
  const r = await req('POST', '/admin/api/products', { body: { sku: 'X', name: 'X' }, headers: { Cookie: cookie } });
  assert.equal(r.status, 403);
});

test('create products and keys', async () => {
  let r = await req('POST', '/admin/api/products', { admin: true, body: { sku: 'MUG', name: 'Mug', price: 9.5, quantity: 10, low_stock_threshold: 3 } });
  assert.equal(r.status, 201);
  assert.equal(r.body.product.quantity, 10);
  r = await req('POST', '/admin/api/products', { admin: true, body: { sku: 'TEE', name: 'T-shirt', price: 20, quantity: 2 } });
  assert.equal(r.status, 201);
  r = await req('POST', '/admin/api/products', { admin: true, body: { sku: 'MUG', name: 'Dup' } });
  assert.equal(r.status, 409);

  readKey = (await req('POST', '/admin/api/keys', { admin: true, body: { label: 'site', scope: 'read' } })).body.key;
  writeKey = (await req('POST', '/admin/api/keys', { admin: true, body: { label: 'site', scope: 'write' } })).body.key;
  assert.match(readKey, /^pk_/);
  assert.match(writeKey, /^sk_/);

  r = await req('POST', '/admin/api/webhooks', { admin: true, body: { url: hookUrl } });
  assert.equal(r.status, 201);
});

test('public API needs a key and respects scope', async () => {
  assert.equal((await req('GET', '/api/v1/stock')).status, 401);
  const r = await req('GET', `/api/v1/stock?key=${readKey}`);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body.stock).sort(), ['MUG', 'TEE']);
  assert.equal(r.headers.get('access-control-allow-origin'), null); // no Origin sent
  const w = await req('POST', '/api/v1/orders', { headers: auth(readKey), body: { order_id: 'x', items: [{ sku: 'MUG', quantity: 1 }] } });
  assert.equal(w.status, 403);
  // write keys must not be accepted in the query string
  assert.equal((await req('GET', `/api/v1/stock?key=${writeKey}`)).status, 401);
});

test('orders deduct stock atomically and idempotently', async () => {
  received.length = 0;
  let r = await req('POST', '/api/v1/orders', { headers: auth(writeKey), body: { order_id: 'A1', items: [{ sku: 'MUG', quantity: 4 }, { sku: 'TEE', quantity: 1 }] } });
  assert.equal(r.status, 201);
  r = await req('POST', '/api/v1/orders', { headers: auth(writeKey), body: { order_id: 'A1', items: [{ sku: 'MUG', quantity: 4 }] } });
  assert.equal(r.status, 200);
  assert.equal(r.body.duplicate, true);

  // Not enough TEE -> nothing changes, MUG untouched too.
  r = await req('POST', '/api/v1/orders', { headers: auth(writeKey), body: { order_id: 'A2', items: [{ sku: 'MUG', quantity: 1 }, { sku: 'TEE', quantity: 5 }] } });
  assert.equal(r.status, 409);
  assert.equal(r.body.details.sku, 'TEE');

  const s = (await req('GET', '/api/v1/stock?skus=MUG,TEE', { headers: auth(readKey) })).body.stock;
  assert.equal(s.MUG.quantity, 6);
  assert.equal(s.TEE.quantity, 1);
  assert.equal(s.TEE.low_stock, true);
});

test('availability check', async () => {
  const r = await req('POST', '/api/v1/availability', { headers: auth(readKey), body: { items: [{ sku: 'MUG', quantity: 6 }, { sku: 'TEE', quantity: 2 }] } });
  assert.equal(r.body.ok, false);
  assert.deepEqual(r.body.items.map((i) => i.ok), [true, false]);
});

test('cancel restocks once', async () => {
  let r = await req('POST', '/api/v1/orders/A1/cancel', { headers: auth(writeKey) });
  assert.equal(r.body.order.status, 'cancelled');
  r = await req('POST', '/api/v1/orders/A1/cancel', { headers: auth(writeKey) });
  assert.equal(r.body.duplicate, true);
  const p = (await req('GET', '/api/v1/products/MUG', { headers: auth(readKey) })).body.product;
  assert.equal(p.quantity, 10);
});

test('webhooks are delivered and signed', async () => {
  await new Promise((r) => setTimeout(r, 200));
  const evs = received.map((x) => x.body.event);
  assert.ok(evs.includes('stock.updated'));
  assert.ok(evs.includes('order.placed'));
  assert.ok(evs.includes('order.cancelled'));
  const hook = (await req('GET', '/admin/api/webhooks', { admin: true })).body.webhooks[0];
  for (const d of received) {
    const sig = crypto.createHmac('sha256', hook.secret).update(d.raw).digest('hex');
    assert.equal(d.headers['x-stock-signature'], sig);
  }
});

test('manual adjust: delta, set, and no negative stock', async () => {
  let r = await req('POST', '/admin/api/products/MUG/adjust', { admin: true, body: { delta: 5, reason: 'restock', reference: 'PO-1' } });
  assert.equal(r.body.product.quantity, 15);
  r = await req('POST', '/admin/api/products/MUG/adjust', { admin: true, body: { set: 7 } });
  assert.equal(r.body.product.quantity, 7);
  r = await req('POST', '/admin/api/products/MUG/adjust', { admin: true, body: { delta: -100 } });
  assert.equal(r.status, 409);
  r = await req('PATCH', '/api/v1/products/MUG/stock', { headers: auth(writeKey), body: { delta: -2, reason: 'damage' } });
  assert.equal(r.body.product.quantity, 5);
  const m = (await req('GET', '/admin/api/movements', { admin: true })).body.movements;
  assert.equal(m[0].reason, 'damage');
});

test('CSV import/export round trip', async () => {
  const csv = 'SKU,Name,Category,Price,Quantity\nCAP,"Cap, blue",Hats,12,8\nMUG,Mug v2,Kitchen,9.5,30\n,missing sku,,,\n';
  const r = await req('POST', '/admin/api/import', { admin: true, body: csv, headers: { 'Content-Type': 'text/csv' } });
  assert.equal(r.body.created, 1);
  assert.equal(r.body.updated, 1);
  assert.equal(r.body.errors.length, 1);
  const out = await req('GET', '/admin/api/export.csv', { admin: true });
  assert.match(out.body, /CAP,"Cap, blue",Hats,12,8/);
  assert.match(out.body, /MUG,Mug v2,Kitchen,9.5,30/);
});

test('bulk catalog push from website', async () => {
  const r = await req('POST', '/api/v1/products/bulk', { headers: auth(writeKey), body: { products: [{ sku: 'NEW1', name: 'New', quantity: 3 }, { sku: 'CAP', price: 15 }] } });
  assert.equal(r.body.created, 1);
  assert.equal(r.body.updated, 1);
  const cap = (await req('GET', '/api/v1/products/CAP', { headers: auth(readKey) })).body.product;
  assert.equal(cap.price, 15);
  assert.equal(cap.quantity, 8);
});

test('CORS preflight for website calls', async () => {
  const res = await fetch(base + '/api/v1/stock', { method: 'OPTIONS', headers: { Origin: 'https://shop.example' } });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('concurrent orders never oversell', async () => {
  await req('POST', '/admin/api/products', { admin: true, body: { sku: 'RARE', name: 'Rare item', quantity: 5 } });
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    req('POST', '/api/v1/orders', { headers: auth(writeKey), body: { order_id: `R${i}`, items: [{ sku: 'RARE', quantity: 1 }] } })));
  assert.equal(results.filter((r) => r.status === 201).length, 5);
  assert.equal((await req('GET', '/api/v1/products/RARE', { headers: auth(readKey) })).body.product.quantity, 0);
});
