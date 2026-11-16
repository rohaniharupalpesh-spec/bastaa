'use strict';
// Business logic for products, stock movements and orders.
// Every stock change goes through `applyChange`, which records a movement row
// and emits an event so webhooks / live listeners can sync.
const { tx } = require('./db');

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const REASONS = ['restock', 'sale', 'adjustment', 'return', 'cancel', 'import', 'damage'];

function toPublic(p) {
  if (!p) return null;
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    description: p.description,
    category: p.category,
    price: p.price,
    quantity: p.quantity,
    in_stock: p.quantity > 0,
    low_stock: p.quantity <= p.low_stock_threshold,
    low_stock_threshold: p.low_stock_threshold,
    active: !!p.active,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

function cleanText(v, max = 500) {
  return v == null ? '' : String(v).trim().slice(0, max);
}

function intOr(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new HttpError(400, `Expected an integer, got "${v}"`);
  return n;
}

function numOr(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `Expected a non-negative number, got "${v}"`);
  return n;
}

function createInventory(db, emit = () => {}) {
  const q = {
    bySku: db.prepare('SELECT * FROM products WHERE sku = ?'),
    byId: db.prepare('SELECT * FROM products WHERE id = ?'),
    setQty: db.prepare("UPDATE products SET quantity = ?, updated_at = datetime('now') WHERE id = ?"),
    addMove: db.prepare(`INSERT INTO stock_movements (product_id, change, quantity_after, reason, reference, note, source)
                         VALUES (?, ?, ?, ?, ?, ?, ?)`),
    orderByExt: db.prepare('SELECT * FROM orders WHERE external_id = ?'),
  };

  function getProduct(key) {
    const p = /^\d+$/.test(String(key)) ? q.byId.get(Number(key)) || q.bySku.get(String(key)) : q.bySku.get(String(key));
    if (!p) throw new HttpError(404, `Product "${key}" not found`);
    return p;
  }

  function listProducts({ search = '', category = '', lowStock = false, includeInactive = true } = {}) {
    const where = [];
    const args = [];
    if (search) {
      where.push('(sku LIKE ? OR name LIKE ? OR category LIKE ?)');
      args.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (category) { where.push('category = ?'); args.push(category); }
    if (lowStock) where.push('quantity <= low_stock_threshold');
    if (!includeInactive) where.push('active = 1');
    const sql = `SELECT * FROM products ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY name COLLATE NOCASE`;
    return db.prepare(sql).all(...args).map(toPublic);
  }

  /** Low-level: change quantity by `delta`. Must be called inside a transaction. */
  function applyChange(product, delta, { reason, reference = '', note = '', source = 'dashboard', allowNegative = false }) {
    if (!REASONS.includes(reason)) throw new HttpError(400, `Unknown reason "${reason}". Use one of: ${REASONS.join(', ')}`);
    const after = product.quantity + delta;
    if (after < 0 && !allowNegative) {
      throw new HttpError(409, `Insufficient stock for ${product.sku}: have ${product.quantity}, need ${-delta}`, {
        sku: product.sku, available: product.quantity, requested: -delta,
      });
    }
    q.setQty.run(after, product.id);
    q.addMove.run(product.id, delta, after, reason, cleanText(reference, 200), cleanText(note), source);
    const updated = q.byId.get(product.id);
    return { before: product.quantity, product: updated };
  }

  function emitStock(changes, meta) {
    for (const { before, product } of changes) {
      const pub = toPublic(product);
      emit('stock.updated', { product: pub, previous_quantity: before, ...meta });
      if (product.quantity <= product.low_stock_threshold && before > product.low_stock_threshold) {
        emit('stock.low', { product: pub });
      }
      if (product.quantity <= 0 && before > 0) emit('stock.out', { product: pub });
    }
  }

  function createProduct(body, source = 'dashboard') {
    const sku = cleanText(body.sku, 64);
    const name = cleanText(body.name, 200);
    if (!sku) throw new HttpError(400, 'sku is required');
    if (!name) throw new HttpError(400, 'name is required');
    if (q.bySku.get(sku)) throw new HttpError(409, `SKU "${sku}" already exists`);
    const qty = intOr(body.quantity, 0);
    if (qty < 0) throw new HttpError(400, 'quantity cannot be negative');

    const product = tx(db, () => {
      const r = db.prepare(`INSERT INTO products (sku, name, description, category, price, quantity, low_stock_threshold, active)
                            VALUES (?, ?, ?, ?, ?, 0, ?, ?)`).run(
        sku, name, cleanText(body.description, 2000), cleanText(body.category, 100),
        numOr(body.price, 0), Math.max(0, intOr(body.low_stock_threshold, 5)), body.active === false ? 0 : 1,
      );
      let p = q.byId.get(Number(r.lastInsertRowid));
      if (qty > 0) p = applyChange(p, qty, { reason: 'restock', note: 'Initial stock', source }).product;
      return p;
    });
    emit('product.created', { product: toPublic(product) });
    return toPublic(product);
  }

  function updateProduct(key, body) {
    const p = getProduct(key);
    const fields = {
      name: body.name !== undefined ? cleanText(body.name, 200) : p.name,
      sku: body.sku !== undefined ? cleanText(body.sku, 64) : p.sku,
      description: body.description !== undefined ? cleanText(body.description, 2000) : p.description,
      category: body.category !== undefined ? cleanText(body.category, 100) : p.category,
      price: numOr(body.price, p.price),
      low_stock_threshold: Math.max(0, intOr(body.low_stock_threshold, p.low_stock_threshold)),
      active: body.active === undefined ? p.active : (body.active ? 1 : 0),
    };
    if (!fields.name) throw new HttpError(400, 'name cannot be empty');
    if (!fields.sku) throw new HttpError(400, 'sku cannot be empty');
    if (fields.sku !== p.sku && q.bySku.get(fields.sku)) throw new HttpError(409, `SKU "${fields.sku}" already exists`);
    db.prepare(`UPDATE products SET name=?, sku=?, description=?, category=?, price=?, low_stock_threshold=?, active=?,
                updated_at=datetime('now') WHERE id=?`).run(
      fields.name, fields.sku, fields.description, fields.category, fields.price, fields.low_stock_threshold, fields.active, p.id,
    );
    const updated = toPublic(q.byId.get(p.id));
    emit('product.updated', { product: updated });
    return updated;
  }

  function deleteProduct(key) {
    const p = getProduct(key);
    db.prepare('DELETE FROM products WHERE id = ?').run(p.id);
    emit('product.deleted', { product: { id: p.id, sku: p.sku } });
  }

  /** Adjust by delta (+/-) or set an absolute quantity. */
  function adjustStock(key, { delta, set, reason, reference, note }, source = 'dashboard') {
    const result = tx(db, () => {
      const p = getProduct(key);
      let d;
      if (set !== undefined && set !== null && set !== '') {
        const target = intOr(set);
        if (target < 0) throw new HttpError(400, 'quantity cannot be negative');
        d = target - p.quantity;
      } else {
        d = intOr(delta);
      }
      if (d === 0) return { before: p.quantity, product: p };
      const r = reason || (set !== undefined && set !== null && set !== '' ? 'adjustment' : d > 0 ? 'restock' : 'adjustment');
      return applyChange(p, d, { reason: r, reference, note, source });
    });
    if (result.before !== result.product.quantity) emitStock([result], { reason: reason || 'adjustment', source });
    return toPublic(result.product);
  }

  function movements({ key, limit = 100 } = {}) {
    const lim = Math.min(Math.max(intOr(limit, 100), 1), 1000);
    if (key) {
      const p = getProduct(key);
      return db.prepare(`SELECT m.*, p.sku, p.name FROM stock_movements m JOIN products p ON p.id = m.product_id
                         WHERE m.product_id = ? ORDER BY m.id DESC LIMIT ?`).all(p.id, lim);
    }
    return db.prepare(`SELECT m.*, p.sku, p.name FROM stock_movements m JOIN products p ON p.id = m.product_id
                       ORDER BY m.id DESC LIMIT ?`).all(lim);
  }

  function normalizeItems(items) {
    if (!Array.isArray(items) || items.length === 0) throw new HttpError(400, 'items must be a non-empty array');
    const merged = new Map();
    for (const it of items) {
      const sku = cleanText(it && it.sku, 64);
      const qty = intOr(it && it.quantity);
      if (!sku) throw new HttpError(400, 'each item needs a sku');
      if (!(qty > 0)) throw new HttpError(400, `quantity for ${sku} must be a positive integer`);
      merged.set(sku, (merged.get(sku) || 0) + qty);
    }
    return [...merged].map(([sku, quantity]) => ({ sku, quantity }));
  }

  /**
   * Record an order from the website. All-or-nothing: if any item lacks stock,
   * nothing is deducted. Idempotent on `order_id` — retries return the original.
   */
  function placeOrder({ order_id, items }, source = 'website') {
    const ext = cleanText(order_id, 200);
    if (!ext) throw new HttpError(400, 'order_id is required');
    const list = normalizeItems(items);

    const existing = q.orderByExt.get(ext);
    if (existing) return { order: formatOrder(existing), duplicate: true };

    const { changes, order } = tx(db, () => {
      const changes = list.map(({ sku, quantity }) => {
        const p = q.bySku.get(sku);
        if (!p) throw new HttpError(404, `Product "${sku}" not found`, { sku });
        if (!p.active) throw new HttpError(409, `Product "${sku}" is not available`, { sku });
        return applyChange(p, -quantity, { reason: 'sale', reference: ext, source });
      });
      db.prepare("INSERT INTO orders (external_id, status, items_json) VALUES (?, 'placed', ?)").run(ext, JSON.stringify(list));
      return { changes, order: q.orderByExt.get(ext) };
    });
    emitStock(changes, { reason: 'sale', reference: ext, source });
    emit('order.placed', { order: formatOrder(order) });
    return { order: formatOrder(order), duplicate: false };
  }

  /** Cancel / refund an order: puts its stock back. Idempotent. */
  function cancelOrder(orderId, source = 'website') {
    const ext = cleanText(orderId, 200);
    const order = q.orderByExt.get(ext);
    if (!order) throw new HttpError(404, `Order "${ext}" not found`);
    if (order.status === 'cancelled') return { order: formatOrder(order), duplicate: true };
    const items = JSON.parse(order.items_json);
    const { changes, updated } = tx(db, () => {
      const changes = [];
      for (const { sku, quantity } of items) {
        const p = q.bySku.get(sku);
        if (p) changes.push(applyChange(p, quantity, { reason: 'cancel', reference: ext, source }));
      }
      db.prepare("UPDATE orders SET status='cancelled', updated_at=datetime('now') WHERE id=?").run(order.id);
      return { changes, updated: q.orderByExt.get(ext) };
    });
    emitStock(changes, { reason: 'cancel', reference: ext, source });
    emit('order.cancelled', { order: formatOrder(updated) });
    return { order: formatOrder(updated), duplicate: false };
  }

  function listOrders(limit = 100) {
    return db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT ?').all(Math.min(intOr(limit, 100), 1000)).map(formatOrder);
  }

  function formatOrder(o) {
    return { order_id: o.external_id, status: o.status, items: JSON.parse(o.items_json), created_at: o.created_at, updated_at: o.updated_at };
  }

  /** Check availability without changing anything (e.g. for a cart page). */
  function checkAvailability(items) {
    const list = normalizeItems(items);
    const results = list.map(({ sku, quantity }) => {
      const p = q.bySku.get(sku);
      const available = p && p.active ? p.quantity : 0;
      return { sku, requested: quantity, available, ok: available >= quantity };
    });
    return { ok: results.every((r) => r.ok), items: results };
  }

  /** Bulk upsert from CSV rows / JSON. Sets quantity to the given value. */
  function importProducts(rows, source = 'import') {
    let created = 0, updated = 0;
    const errors = [];
    rows.forEach((row, i) => {
      try {
        const sku = cleanText(row.sku, 64);
        if (!sku) throw new HttpError(400, 'missing sku');
        if (q.bySku.get(sku)) {
          const { quantity, ...rest } = row;
          updateProduct(sku, rest);
          if (quantity !== undefined && quantity !== '') adjustStock(sku, { set: quantity, reason: 'import' }, source);
          updated++;
        } else {
          createProduct(row, source);
          created++;
        }
      } catch (e) {
        errors.push({ row: i + 1, sku: row && row.sku, error: e.message });
      }
    });
    return { created, updated, errors };
  }

  function stats() {
    return db.prepare(`SELECT COUNT(*) AS products,
                              COALESCE(SUM(quantity),0) AS units,
                              COALESCE(SUM(quantity * price),0) AS stock_value,
                              SUM(CASE WHEN quantity <= 0 THEN 1 ELSE 0 END) AS out_of_stock,
                              SUM(CASE WHEN quantity > 0 AND quantity <= low_stock_threshold THEN 1 ELSE 0 END) AS low_stock
                       FROM products WHERE active = 1`).get();
  }

  return {
    getProduct: (k) => toPublic(getProduct(k)),
    listProducts, createProduct, updateProduct, deleteProduct, adjustStock,
    movements, placeOrder, cancelOrder, listOrders, checkAvailability, importProducts, stats,
  };
}

module.exports = { createInventory, HttpError, REASONS, toPublic };
