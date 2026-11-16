'use strict';
// Dashboard login (single admin password -> signed session cookie) and
// API keys for websites (hashed at rest, "read" or "write" scope).
const crypto = require('node:crypto');
const { HttpError } = require('./inventory');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createAuth(db, { adminPassword, sessionSecret, sessionHours = 12, secureCookies = false }) {
  const COOKIE = 'stock_session';

  function sign(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', sessionSecret).update(body).digest('base64url');
    return `${body}.${sig}`;
  }

  function verify(token) {
    if (!token || !token.includes('.')) return null;
    const [body, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', sessionSecret).update(body).digest('base64url');
    if (!safeEqual(sig, expected)) return null;
    try {
      const data = JSON.parse(Buffer.from(body, 'base64url').toString());
      return data.exp > Date.now() ? data : null;
    } catch { return null; }
  }

  function login(req, res) {
    const password = req.body && req.body.password;
    if (!password || !safeEqual(sha256(password), sha256(adminPassword))) {
      throw new HttpError(401, 'Incorrect password');
    }
    const maxAge = sessionHours * 3600;
    const token = sign({ role: 'admin', exp: Date.now() + maxAge * 1000 });
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`);
    res.json({ ok: true });
  }

  function logout(_req, res) {
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    res.json({ ok: true });
  }

  function requireAdmin(req, _res, next) {
    const session = verify(parseCookies(req.headers.cookie)[COOKIE]);
    if (!session) return next(new HttpError(401, 'Not logged in'));
    next();
  }

  // ---- API keys -------------------------------------------------------
  const findKey = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?');
  const touchKey = db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?");

  function createApiKey(label, scope) {
    if (!['read', 'write'].includes(scope)) throw new HttpError(400, 'scope must be "read" or "write"');
    const prefix = scope === 'read' ? 'pk_' : 'sk_';
    const key = prefix + crypto.randomBytes(24).toString('base64url');
    db.prepare('INSERT INTO api_keys (label, key_hash, key_prefix, scope) VALUES (?, ?, ?, ?)')
      .run(String(label || 'Website').slice(0, 100), sha256(key), key.slice(0, 10), scope);
    return key; // only time the full key is visible
  }

  function listApiKeys() {
    return db.prepare('SELECT id, label, key_prefix, scope, created_at, last_used_at FROM api_keys ORDER BY id DESC').all();
  }

  function revokeApiKey(id) {
    db.prepare('DELETE FROM api_keys WHERE id = ?').run(Number(id));
  }

  /** Middleware: accepts `Authorization: Bearer <key>`, `X-API-Key`, or `?key=` (read keys only). */
  function requireKey(scope) {
    return (req, _res, next) => {
      const header = req.headers.authorization || '';
      let key = header.startsWith('Bearer ') ? header.slice(7).trim() : req.headers['x-api-key'];
      if (!key && req.query.key && String(req.query.key).startsWith('pk_')) key = String(req.query.key);
      if (!key) return next(new HttpError(401, 'Missing API key'));
      const row = findKey.get(sha256(String(key)));
      if (!row) return next(new HttpError(401, 'Invalid API key'));
      if (scope === 'write' && row.scope !== 'write') return next(new HttpError(403, 'This key is read-only'));
      touchKey.run(row.id);
      req.apiKey = row;
      next();
    };
  }

  return { login, logout, requireAdmin, requireKey, createApiKey, listApiKeys, revokeApiKey };
}

module.exports = { createAuth };
