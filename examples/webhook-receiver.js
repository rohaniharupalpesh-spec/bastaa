// Example: receive stock webhooks on your website's server (Node/Express).
// Run: WEBHOOK_SECRET=whsec_... node examples/webhook-receiver.js
const crypto = require('node:crypto');
const express = require('express');

const app = express();
const SECRET = process.env.WEBHOOK_SECRET;

app.post('/stock-webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const expected = crypto.createHmac('sha256', SECRET).update(req.body).digest('hex');
  const got = req.get('X-Stock-Signature') || '';
  if (got.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
    return res.status(401).send('bad signature');
  }
  const evt = JSON.parse(req.body);
  if (evt.event === 'stock.updated') {
    const { sku, quantity } = evt.data.product;
    console.log(`Update product ${sku} on the website -> ${quantity} in stock`);
    // e.g. db.query('UPDATE products SET stock = ? WHERE sku = ?', [quantity, sku])
  }
  res.sendStatus(200);
});

app.listen(4000, () => console.log('Listening for webhooks on http://localhost:4000/stock-webhook'));
