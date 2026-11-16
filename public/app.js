/* Stock Manager dashboard — vanilla JS, no build step. */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const when = (s) => (s ? new Date(s.replace(' ', 'T') + (s.endsWith('Z') ? '' : 'Z')).toLocaleString() : '');

  const state = { products: [], reasons: [], editing: null, adjusting: null, tab: 'products', es: null };

  async function api(path, opts = {}) {
    const headers = { 'X-Requested-With': 'stock-dashboard', ...(opts.headers || {}) };
    let body = opts.body;
    if (body && typeof body === 'object') { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
    const res = await fetch('/admin/api' + path, { ...opts, headers, body, credentials: 'same-origin' });
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    if (res.status === 401 && path !== '/login') { showLogin(); throw new Error('Please sign in'); }
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data;
  }

  let toastTimer;
  function toast(msg, isErr = false) {
    const t = $('#toast');
    t.textContent = msg; t.className = 'toast' + (isErr ? ' err' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
  }

  // ------------------------------------------------------------- auth
  function showLogin() { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); state.es && state.es.close(); }
  async function boot() {
    try {
      const me = await api('/me');
      state.reasons = me.reasons;
      $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
      $('#adjust-form [name=reason]').innerHTML = me.reasons.map((r) => `<option>${r}</option>`).join('');
      fillSnippets();
      connectLive();
      switchTab(location.hash.slice(1) || 'products');
    } catch { /* showLogin already called */ }
  }
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#login-error').textContent = '';
    try { await api('/login', { method: 'POST', body: { password: e.target.password.value } }); e.target.reset(); boot(); }
    catch (err) { $('#login-error').textContent = err.message; }
  });
  $('#logout').addEventListener('click', async () => { await api('/logout', { method: 'POST' }).catch(() => {}); showLogin(); });

  // ------------------------------------------------------------- tabs
  function switchTab(tab) {
    if (!$(`#tab-${tab}`)) tab = 'products';
    state.tab = tab; history.replaceState(null, '', '#' + tab);
    $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.panel').forEach((p) => p.classList.toggle('hidden', p.id !== `tab-${tab}`));
    ({ products: loadProducts, activity: loadMovements, orders: loadOrders, sync: loadSync })[tab]();
  }
  $$('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  // ------------------------------------------------------------- products
  async function loadProducts() {
    const params = new URLSearchParams();
    if ($('#search').value) params.set('search', $('#search').value);
    if ($('#low-only').checked) params.set('low_stock', 'true');
    const [{ products }, stats] = await Promise.all([api('/products?' + params), api('/stats')]);
    state.products = products;
    renderStats(stats);
    renderProducts();
  }

  function renderStats(s) {
    $('#stats').innerHTML = [
      ['Active products', s.products, ''],
      ['Units in stock', s.units, ''],
      ['Stock value', money(s.stock_value), ''],
      ['Low stock', s.low_stock || 0, s.low_stock ? 'warn' : ''],
      ['Out of stock', s.out_of_stock || 0, s.out_of_stock ? 'bad' : ''],
    ].map(([l, v, c]) => `<div class="stat ${c}"><div class="label">${l}</div><div class="value">${esc(v)}</div></div>`).join('');
  }

  function statusBadge(p) {
    if (!p.active) return '<span class="badge off">Hidden</span>';
    if (p.quantity <= 0) return '<span class="badge bad">Out of stock</span>';
    if (p.low_stock) return '<span class="badge warn">Low stock</span>';
    return '<span class="badge ok">In stock</span>';
  }

  function productRow(p) {
    return `<tr data-id="${p.id}">
      <td><code>${esc(p.sku)}</code></td>
      <td>${esc(p.name)}</td>
      <td>${esc(p.category)}</td>
      <td class="num">${money(p.price)}</td>
      <td class="num qty">${p.quantity}</td>
      <td>${statusBadge(p)}</td>
      <td><div class="quick">
        <button class="btn sm" data-q="-1" title="Remove 1">−</button>
        <input type="number" value="1" min="1" step="1" aria-label="Amount">
        <button class="btn sm" data-q="1" title="Add">+</button>
        <button class="btn sm" data-act="adjust">More…</button>
      </div></td>
      <td><button class="btn sm ghost" data-act="edit">Edit</button></td>
    </tr>`;
  }

  function renderProducts() {
    $('#product-rows').innerHTML = state.products.map(productRow).join('');
    $('#empty-products').classList.toggle('hidden', state.products.length > 0);
    const cats = [...new Set(state.products.map((p) => p.category).filter(Boolean))];
    $('#categories').innerHTML = cats.map((c) => `<option value="${esc(c)}">`).join('');
  }

  $('#product-rows').addEventListener('click', async (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    const tr = btn.closest('tr'); const p = state.products.find((x) => x.id === Number(tr.dataset.id));
    if (btn.dataset.q) {
      const amount = Math.max(1, parseInt($('input', tr).value, 10) || 1) * Number(btn.dataset.q);
      try {
        await api(`/products/${p.id}/adjust`, { method: 'POST', body: { delta: amount, reason: amount > 0 ? 'restock' : 'adjustment' } });
        toast(`${p.sku}: ${amount > 0 ? '+' : ''}${amount}`);
        loadProducts();
      } catch (err) { toast(err.message, true); }
    } else if (btn.dataset.act === 'edit') openProduct(p);
    else if (btn.dataset.act === 'adjust') openAdjust(p);
  });

  let searchTimer;
  $('#search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadProducts, 250); });
  $('#low-only').addEventListener('change', loadProducts);

  // product dialog
  function openProduct(p) {
    state.editing = p || null;
    const f = $('#product-form'); f.reset();
    $('#product-dialog-title').textContent = p ? `Edit ${p.name}` : 'Add product';
    $('#qty-field').classList.toggle('hidden', !!p);
    $('#delete-product').classList.toggle('hidden', !p);
    $('#product-error').textContent = '';
    if (p) for (const k of ['sku', 'name', 'category', 'price', 'low_stock_threshold', 'description']) f[k].value = p[k];
    f.active.checked = p ? p.active : true;
    $('#product-dialog').showModal();
  }
  $('#add-product').addEventListener('click', () => openProduct(null));
  $('#product-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = { sku: f.sku.value, name: f.name.value, category: f.category.value, price: f.price.value,
      low_stock_threshold: f.low_stock_threshold.value, description: f.description.value, active: f.active.checked };
    try {
      if (state.editing) await api(`/products/${state.editing.id}`, { method: 'PUT', body });
      else await api('/products', { method: 'POST', body: { ...body, quantity: f.quantity.value } });
      $('#product-dialog').close(); toast('Saved'); loadProducts();
    } catch (err) { $('#product-error').textContent = err.message; }
  });
  $('#delete-product').addEventListener('click', async () => {
    const p = state.editing;
    if (!confirm(`Delete ${p.name} (${p.sku})? Its stock history will also be removed.`)) return;
    try { await api(`/products/${p.id}`, { method: 'DELETE' }); $('#product-dialog').close(); toast('Deleted'); loadProducts(); }
    catch (err) { $('#product-error').textContent = err.message; }
  });

  // adjust dialog
  function openAdjust(p) {
    state.adjusting = p;
    const f = $('#adjust-form'); f.reset();
    $('#adjust-name').textContent = p.name; $('#adjust-current').textContent = p.quantity; $('#adjust-error').textContent = '';
    f.reason.value = 'restock';
    $('#adjust-dialog').showModal(); f.amount.focus();
  }
  $('#adjust-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = { reason: f.reason.value, reference: f.reference.value, note: f.note.value };
    body[f.mode.value === 'set' ? 'set' : 'delta'] = f.amount.value;
    try { await api(`/products/${state.adjusting.id}/adjust`, { method: 'POST', body }); $('#adjust-dialog').close(); toast('Stock updated'); loadProducts(); }
    catch (err) { $('#adjust-error').textContent = err.message; }
  });
  $$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  // import / export
  $('#export').addEventListener('click', () => { location.href = '/admin/api/export.csv'; });
  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const r = await api('/import', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: await file.text() });
      toast(`Imported: ${r.created} new, ${r.updated} updated${r.errors.length ? `, ${r.errors.length} errors` : ''}`, r.errors.length > 0);
      if (r.errors.length) console.warn('Import errors', r.errors);
      loadProducts();
    } catch (err) { toast(err.message, true); }
    e.target.value = '';
  });

  // ------------------------------------------------------------- activity & orders
  async function loadMovements() {
    const { movements } = await api('/movements?limit=200');
    $('#movement-rows').innerHTML = movements.map((m) => `<tr>
      <td>${when(m.created_at)}</td><td><code>${esc(m.sku)}</code></td><td>${esc(m.name)}</td>
      <td class="num ${m.change > 0 ? 'pos' : 'neg'}">${m.change > 0 ? '+' : ''}${m.change}</td>
      <td class="num">${m.quantity_after}</td><td>${esc(m.reason)}</td><td>${esc(m.reference)}</td>
      <td>${esc(m.source)}</td><td>${esc(m.note)}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">No activity yet.</td></tr>';
  }

  async function loadOrders() {
    const { orders } = await api('/orders?limit=200');
    $('#empty-orders').classList.toggle('hidden', orders.length > 0);
    $('#order-rows').innerHTML = orders.map((o) => `<tr>
      <td><code>${esc(o.order_id)}</code></td>
      <td>${o.status === 'placed' ? '<span class="badge ok">Placed</span>' : '<span class="badge off">Cancelled</span>'}</td>
      <td>${o.items.map((i) => `${esc(i.sku)} × ${i.quantity}`).join(', ')}</td>
      <td>${when(o.created_at)}</td>
      <td>${o.status === 'placed' ? `<button class="btn sm" data-cancel="${esc(o.order_id)}">Cancel &amp; restock</button>` : ''}</td></tr>`).join('');
  }
  $('#order-rows').addEventListener('click', async (e) => {
    const id = e.target.dataset.cancel; if (!id) return;
    if (!confirm(`Cancel order ${id} and put its items back in stock?`)) return;
    try { await api(`/orders/${encodeURIComponent(id)}/cancel`, { method: 'POST' }); toast('Order cancelled'); loadOrders(); }
    catch (err) { toast(err.message, true); }
  });

  // ------------------------------------------------------------- sync
  async function loadSync() {
    const [{ keys }, { webhooks }] = await Promise.all([api('/keys'), api('/webhooks')]);
    $('#key-list').innerHTML = keys.map((k) => `<li>
      <span class="badge ${k.scope === 'write' ? 'warn' : 'ok'}">${k.scope}</span>
      <span class="grow"><b>${esc(k.label)}</b> <code>${esc(k.key_prefix)}…</code><br>
        <small class="muted">Created ${when(k.created_at)} · ${k.last_used_at ? 'last used ' + when(k.last_used_at) : 'never used'}</small></span>
      <button class="btn sm danger" data-revoke="${k.id}">Revoke</button></li>`).join('') || '<li class="muted">No keys yet.</li>';
    $('#hook-list').innerHTML = webhooks.map((w) => `<li>
      <span class="grow"><b>${esc(w.url)}</b><br>
        <small class="muted">Signing secret: <code>${esc(w.secret)}</code><br>Last delivery: ${esc(w.last_status || 'none yet')}</small></span>
      <label class="check"><input type="checkbox" data-toggle="${w.id}" ${w.active ? 'checked' : ''}> Active</label>
      <button class="btn sm" data-test="${w.id}">Send test</button>
      <button class="btn sm danger" data-delhook="${w.id}">Remove</button></li>`).join('') || '<li class="muted">No webhooks yet.</li>';
  }
  $('#key-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { key } = await api('/keys', { method: 'POST', body: { label: e.target.label.value, scope: e.target.scope.value } });
      const box = $('#new-key'); box.classList.remove('hidden');
      box.innerHTML = `<b>Copy this key now — it won't be shown again:</b><br><code>${esc(key)}</code>`;
      if (key.startsWith('pk_')) fillSnippets(key);
      e.target.reset(); loadSync();
    } catch (err) { toast(err.message, true); }
  });
  $('#key-list').addEventListener('click', async (e) => {
    const id = e.target.dataset.revoke; if (!id || !confirm('Revoke this key? Any website using it will stop syncing.')) return;
    await api(`/keys/${id}`, { method: 'DELETE' }); loadSync();
  });
  $('#hook-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/webhooks', { method: 'POST', body: { url: e.target.url.value } }); e.target.reset(); loadSync(); }
    catch (err) { toast(err.message, true); }
  });
  $('#hook-list').addEventListener('click', async (e) => {
    const t = e.target;
    try {
      if (t.dataset.delhook && confirm('Remove this webhook?')) { await api(`/webhooks/${t.dataset.delhook}`, { method: 'DELETE' }); loadSync(); }
      if (t.dataset.test) { t.disabled = true; const r = await api(`/webhooks/${t.dataset.test}/test`, { method: 'POST' }); toast(r.ok ? 'Test delivered' : `Test failed: ${r.last_status}`, !r.ok); loadSync(); }
    } catch (err) { toast(err.message, true); }
  });
  $('#hook-list').addEventListener('change', async (e) => {
    const id = e.target.dataset.toggle; if (!id) return;
    await api(`/webhooks/${id}`, { method: 'PATCH', body: { active: e.target.checked } });
  });

  function fillSnippets(readKey = 'pk_YOUR_READ_KEY') {
    const origin = location.origin;
    $('#embed-snippet').textContent =
`<script src="${origin}/embed.js" data-key="${readKey}" defer></script>

<!-- anywhere on your product pages -->
<span data-stock-sku="TSHIRT-RED-M"></span>          <!-- "12 in stock" / "Out of stock" -->
<span data-stock-sku="TSHIRT-RED-M" data-stock-format="number"></span>
<button data-stock-sku="TSHIRT-RED-M" data-stock-disable-when-out>Add to cart</button>`;
    $('#order-snippet').textContent =
`curl -X POST ${origin}/api/v1/orders \\
  -H "Authorization: Bearer sk_YOUR_WRITE_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"order_id":"1001","items":[{"sku":"TSHIRT-RED-M","quantity":2}]}'`;
    $('#cancel-snippet').textContent =
`curl -X POST ${origin}/api/v1/orders/1001/cancel \\
  -H "Authorization: Bearer sk_YOUR_WRITE_KEY"`;
  }

  // ------------------------------------------------------------- live updates
  function connectLive() {
    state.es && state.es.close();
    const es = new EventSource('/admin/api/events');
    state.es = es;
    es.onopen = () => $('#live').classList.add('on');
    es.onerror = () => $('#live').classList.remove('on');
    let refresh;
    const onChange = (ev) => {
      const { data } = JSON.parse(ev.data);
      clearTimeout(refresh);
      refresh = setTimeout(() => {
        if (state.tab === 'products') loadProducts().then(() => {
          const row = data.product && $(`#product-rows tr[data-id="${data.product.id}"]`);
          if (row) { row.classList.add('flash'); }
        });
        else if (state.tab === 'activity') loadMovements();
        else if (state.tab === 'orders') loadOrders();
      }, 150);
    };
    ['stock.updated', 'product.created', 'product.updated', 'product.deleted', 'order.placed', 'order.cancelled']
      .forEach((n) => es.addEventListener(n, onChange));
    es.addEventListener('stock.low', (ev) => { const { data } = JSON.parse(ev.data); toast(`Low stock: ${data.product.name} (${data.product.quantity} left)`, true); });
  }

  boot();
})();
