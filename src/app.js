'use strict';
const path = require('node:path');
const { EventEmitter } = require('node:events');
const express = require('express');
const { openDb } = require('./db');
const { createInventory, HttpError, REASONS } = require('./inventory');
const { createAuth } = require('./auth');
const { createWebhooks } = require('./webhooks');
const { parseCsv, toCsv } = require('./csv');

const CSV_COLUMNS = ['sku', 'name', 'category', 'price', 'quantity', 'low_stock_threshold', 'active', 'description'];

function createApp(config) {
  const db = openDb(config.dbFile);
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  const webhooks = createWebhooks(db, config.webhookOptions);
  const inventory = createInventory(db, (event, data) => {
    bus.emit('event', { event, data, at: new Date().toISOString() });
    webhooks.dispatch(event, data).catch(() => {});
  });
  const auth = createAuth(db, config);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ?? false);
  app.use(express.json({ limit: '2mb' }));
  app.use(express.text({ type: ['text/csv', 'text/plain'], limit: '5mb' }));

  const wrap = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);

  // ---------------------------------------------------------------- health
  app.get('/health', (_req, res) => res.json({ ok: true }));

  // =====================================================================
  //  Website / integration API  (/api/v1)  — authenticated with API keys
  // =====================================================================
  const api = express.Router();
  api.use((req, res, next) => {
    const origin = req.headers.origin;
    const allowed = config.allowedOrigins;
    if (origin && (allowed.includes('*') || allowed.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', allowed.includes('*') ? '*' : origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, X-API-Key, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  const read = auth.requireKey('read');
  const write = auth.requireKey('write');

  api.get('/products', read, wrap((req, res) => {
    res.json({ products: inventory.listProducts({ search: req.query.search, category: req.query.category, includeInactive: req.query.include_inactive === 'true' }) });
  }));
  api.get('/products/:sku', read, wrap((req, res) => res.json({ product: inventory.getProduct(req.params.sku) })));

  // Compact stock map: GET /api/v1/stock?skus=A,B  ->  { stock: { A: { quantity, in_stock, low_stock } } }
  api.get('/stock', read, wrap((req, res) => {
    const wanted = req.query.skus ? new Set(String(req.query.skus).split(',').map((s) => s.trim())) : null;
    const stock = {};
    for (const p of inventory.listProducts({ includeInactive: false })) {
      if (!wanted || wanted.has(p.sku)) stock[p.sku] = { quantity: p.quantity, in_stock: p.in_stock, low_stock: p.low_stock, price: p.price };
    }
    res.json({ stock, at: new Date().toISOString() });
  }));

  api.post('/availability', read, wrap((req, res) => res.json(inventory.checkAvailability(req.body && req.body.items))));

  api.post('/orders', write, wrap((req, res) => {
    const out = inventory.placeOrder(req.body || {}, `api:${req.apiKey.label}`);
    res.status(out.duplicate ? 200 : 201).json(out);
  }));
  api.post('/orders/:id/cancel', write, wrap((req, res) => res.json(inventory.cancelOrder(req.params.id, `api:${req.apiKey.label}`))));

  api.patch('/products/:sku/stock', write, wrap((req, res) => {
    res.json({ product: inventory.adjustStock(req.params.sku, req.body || {}, `api:${req.apiKey.label}`) });
  }));

  // Push your catalog from the website (create or update by SKU).
  api.post('/products/bulk', write, wrap((req, res) => {
    const rows = Array.isArray(req.body) ? req.body : req.body && req.body.products;
    if (!Array.isArray(rows)) throw new HttpError(400, 'Send an array of products or { products: [...] }');
    res.json(inventory.importProducts(rows, `api:${req.apiKey.label}`));
  }));

  // Live updates via Server-Sent Events.  new EventSource('/api/v1/events?key=pk_...')
  api.get('/events', read, (req, res) => sse(req, res, (e) => e.event.startsWith('stock.') || e.event.startsWith('product.')));

  app.use('/api/v1', api);

  // =====================================================================
  //  Dashboard API (/admin/api) — authenticated with the admin session
  // =====================================================================
  const admin = express.Router();
  admin.post('/login', wrap((req, res) => auth.login(req, res)));
  admin.post('/logout', (req, res) => auth.logout(req, res));
  admin.use(auth.requireAdmin);
  // CSRF hardening: state-changing dashboard requests must be same-origin JSON/CSV fetches.
  admin.use((req, _res, next) => {
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'stock-dashboard') return next(new HttpError(403, 'Missing X-Requested-With header'));
    next();
  });

  admin.get('/me', (_req, res) => res.json({ ok: true, reasons: REASONS, events: webhooks.EVENTS }));
  admin.get('/stats', (_req, res) => res.json(inventory.stats()));
  admin.get('/products', wrap((req, res) => res.json({
    products: inventory.listProducts({ search: req.query.search, category: req.query.category, lowStock: req.query.low_stock === 'true' }),
  })));
  admin.post('/products', wrap((req, res) => res.status(201).json({ product: inventory.createProduct(req.body || {}) })));
  admin.get('/products/:key', wrap((req, res) => res.json({ product: inventory.getProduct(req.params.key), movements: inventory.movements({ key: req.params.key, limit: 50 }) })));
  admin.put('/products/:key', wrap((req, res) => res.json({ product: inventory.updateProduct(req.params.key, req.body || {}) })));
  admin.delete('/products/:key', wrap((req, res) => { inventory.deleteProduct(req.params.key); res.json({ ok: true }); }));
  admin.post('/products/:key/adjust', wrap((req, res) => res.json({ product: inventory.adjustStock(req.params.key, req.body || {}, 'dashboard') })));
  admin.get('/movements', wrap((req, res) => res.json({ movements: inventory.movements({ limit: req.query.limit }) })));
  admin.get('/orders', wrap((req, res) => res.json({ orders: inventory.listOrders(req.query.limit) })));
  admin.post('/orders/:id/cancel', wrap((req, res) => res.json(inventory.cancelOrder(req.params.id, 'dashboard'))));

  admin.get('/export.csv', (_req, res) => {
    const rows = inventory.listProducts().map((p) => ({ ...p, active: p.active ? 'true' : 'false' }));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="stock-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(toCsv(rows, CSV_COLUMNS));
  });
  admin.post('/import', wrap((req, res) => {
    const rows = typeof req.body === 'string' ? parseCsv(req.body) : Array.isArray(req.body) ? req.body : [];
    if (!rows.length) throw new HttpError(400, 'No rows found. Send CSV with a header row: ' + CSV_COLUMNS.join(','));
    for (const r of rows) if (typeof r.active === 'string') r.active = !/^(false|0|no)$/i.test(r.active);
    res.json(inventory.importProducts(rows, 'import'));
  }));

  admin.get('/keys', (_req, res) => res.json({ keys: auth.listApiKeys() }));
  admin.post('/keys', wrap((req, res) => res.status(201).json({ key: auth.createApiKey(req.body && req.body.label, req.body && req.body.scope) })));
  admin.delete('/keys/:id', (req, res) => { auth.revokeApiKey(req.params.id); res.json({ ok: true }); });

  admin.get('/webhooks', (_req, res) => res.json({ webhooks: webhooks.list() }));
  admin.post('/webhooks', wrap((req, res) => res.status(201).json({ webhook: webhooks.create(req.body || {}) })));
  admin.patch('/webhooks/:id', (req, res) => { webhooks.setActive(req.params.id, !!(req.body && req.body.active)); res.json({ ok: true }); });
  admin.delete('/webhooks/:id', (req, res) => { webhooks.remove(req.params.id); res.json({ ok: true }); });
  admin.post('/webhooks/:id/test', wrap(async (req, res) => res.json(await webhooks.test(req.params.id))));

  admin.get('/events', (req, res) => sse(req, res, () => true));

  app.use('/admin/api', admin);

  // ------------------------------------------------------------ static files
  app.get('/embed.js', (_req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.sendFile(path.join(__dirname, '..', 'public', 'embed.js'));
  });
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

  // ------------------------------------------------------------ errors
  app.use((req, _res, next) => next(new HttpError(404, `No route for ${req.method} ${req.path}`)));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message, ...(err.details ? { details: err.details } : {}) });
  });

  function sse(req, res, filter) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 5000\n\n');
    const onEvent = (e) => { if (filter(e)) res.write(`event: ${e.event}\ndata: ${JSON.stringify(e)}\n\n`); };
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    bus.on('event', onEvent);
    req.on('close', () => { clearInterval(ping); bus.off('event', onEvent); });
  }

  return { app, db, inventory, auth, webhooks, bus };
}

module.exports = { createApp };
