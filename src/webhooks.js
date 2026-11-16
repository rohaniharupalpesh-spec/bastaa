'use strict';
// Outgoing webhooks: POST every inventory event to your website so it stays in
// sync. Each request is signed: X-Stock-Signature = hex HMAC-SHA256(secret, raw body).
const crypto = require('node:crypto');
const { HttpError } = require('./inventory');

const EVENTS = ['stock.updated', 'stock.low', 'stock.out', 'product.created', 'product.updated', 'product.deleted', 'order.placed', 'order.cancelled'];

function createWebhooks(db, { fetchImpl = fetch, retries = 3, timeoutMs = 8000, log = console } = {}) {
  function list() {
    return db.prepare('SELECT id, url, secret, events, active, last_status, created_at FROM webhooks ORDER BY id').all()
      .map((w) => ({ ...w, active: !!w.active, events: w.events === '*' ? ['*'] : w.events.split(',') }));
  }

  function create({ url, events }) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new HttpError(400, 'url must be a valid http(s) URL'); }
    if (!/^https?:$/.test(parsed.protocol)) throw new HttpError(400, 'url must be http or https');
    const evs = !events || events === '*' || (Array.isArray(events) && (events.length === 0 || events.includes('*')))
      ? '*'
      : [].concat(events).filter((e) => EVENTS.includes(e)).join(',') || '*';
    const secret = 'whsec_' + crypto.randomBytes(24).toString('base64url');
    const r = db.prepare('INSERT INTO webhooks (url, secret, events) VALUES (?, ?, ?)').run(parsed.toString(), secret, evs);
    return list().find((w) => w.id === Number(r.lastInsertRowid));
  }

  function remove(id) { db.prepare('DELETE FROM webhooks WHERE id = ?').run(Number(id)); }

  function setActive(id, active) { db.prepare('UPDATE webhooks SET active = ? WHERE id = ?').run(active ? 1 : 0, Number(id)); }

  const setStatus = db.prepare('UPDATE webhooks SET last_status = ? WHERE id = ?');

  async function deliver(hook, payload) {
    const body = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', hook.secret).update(body).digest('hex');
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const res = await fetchImpl(hook.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Stock-Event': payload.event, 'X-Stock-Signature': signature, 'User-Agent': 'stock-manager-webhook/1.0' },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        setStatus.run(`${res.status} at ${new Date().toISOString()}`, hook.id);
        if (res.ok) return true;
      } catch (err) {
        setStatus.run(`error: ${err.message} at ${new Date().toISOString()}`, hook.id);
      }
      if (attempt < retries) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
    log.warn && log.warn(`[webhook] giving up on ${hook.url} for ${payload.event}`);
    return false;
  }

  /** Fire-and-forget dispatch to every subscribed, active hook. */
  function dispatch(event, data) {
    const payload = { id: 'evt_' + crypto.randomBytes(8).toString('hex'), event, created_at: new Date().toISOString(), data };
    const hooks = db.prepare('SELECT * FROM webhooks WHERE active = 1').all()
      .filter((h) => h.events === '*' || h.events.split(',').includes(event));
    return Promise.all(hooks.map((h) => deliver(h, payload)));
  }

  async function test(id) {
    const hook = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(Number(id));
    if (!hook) throw new HttpError(404, 'Webhook not found');
    const ok = await deliver({ ...hook }, { id: 'evt_test', event: 'ping', created_at: new Date().toISOString(), data: { message: 'Test from Stock Manager' } });
    return { ok, last_status: db.prepare('SELECT last_status FROM webhooks WHERE id = ?').get(hook.id).last_status };
  }

  return { list, create, remove, setActive, dispatch, test, EVENTS };
}

module.exports = { createWebhooks, EVENTS };
