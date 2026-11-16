'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { createApp } = require('./app');

// Load .env if present (KEY=value lines), without overriding real env vars.
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const env = process.env;
if (!env.ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD is not set. Copy .env.example to .env and set a password.');
  process.exit(1);
}
if (!env.SESSION_SECRET) console.warn('SESSION_SECRET not set: using a random one (you will be logged out on restart).');

const { app } = createApp({
  dbFile: env.DATABASE_FILE || path.join(__dirname, '..', 'data', 'stock.db'),
  adminPassword: env.ADMIN_PASSWORD,
  sessionSecret: env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  secureCookies: env.SECURE_COOKIES === 'true',
  trustProxy: env.TRUST_PROXY === 'true' ? 1 : false,
  allowedOrigins: (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean),
});

const port = Number(env.PORT) || 3000;
app.listen(port, () => console.log(`Stock Manager running at http://localhost:${port}`));
