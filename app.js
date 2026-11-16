'use strict';
/* Bastaa Orders — custom order tracker with due-date reminders.
   All data stays on this device (IndexedDB). Settings live in localStorage. */

const STATUSES = ['Received', 'In Production', 'Ready', 'Delivered', 'Cancelled'];
const CLOSED = new Set(['Delivered', 'Cancelled']);
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

/* ---------- storage ---------- */
const DB_NAME = 'bastaa-orders', STORE = 'orders';
let dbp;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, mode), s = t.objectStore(STORE);
    const out = fn(s);
    t.oncomplete = () => res(out && 'result' in out ? out.result : out);
    t.onerror = () => rej(t.error);
  });
}
const getAll = () => tx('readonly', s => s.getAll());
const putOrder = o => tx('readwrite', s => s.put(o));
const delOrder = id => tx('readwrite', s => s.delete(id));
const clearAll = () => tx('readwrite', s => s.clear());

function lsGet(k, def) { try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch { return def; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

const DEFAULT_SETTINGS = { defaultRemindDays: 3, businessName: 'Bastaa', prefix: 'BST' };
let settings = { ...DEFAULT_SETTINGS, ...lsGet('bastaa.settings', {}) };

/* ---------- dates & money ---------- */
const pad = n => String(n).padStart(2, '0');
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const parseISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const daysUntil = iso => Math.round((parseISO(iso) - parseISO(todayISO())) / 86400000);
const fmtDate = iso => iso ? parseISO(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const money = n => '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function dueText(days) {
  if (days < 0) return `${-days} day${days === -1 ? '' : 's'} overdue`;
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  return `Due in ${days} days`;
}
const remindDaysFor = o => (o.remindDays === '' || o.remindDays == null) ? Number(settings.defaultRemindDays) : Number(o.remindDays);
const orderTotal = o => o.items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.price) || 0), 0);
const orderBalance = o => orderTotal(o) - (Number(o.advance) || 0);
function urgency(o) {
  if (CLOSED.has(o.status)) return 'done';
  const d = daysUntil(o.dueDate);
  if (d < 0) return 'overdue';
  if (d <= remindDaysFor(o)) return 'soon';
  return 'ok';
}

/* ---------- state ---------- */
let orders = [];
let editing = null;          // order being edited (or null for new)
let formPhotos = [];         // per-item photo arrays while the form is open

async function load() {
  orders = await getAll();
  render();
  checkReminders();
}

function nextOrderNo() {
  const nums = orders.map(o => parseInt(String(o.orderNo).replace(/\D/g, ''), 10)).filter(n => !isNaN(n));
  const n = (nums.length ? Math.max(...nums) : 1000) + 1;
  return `${settings.prefix || 'BST'}-${n}`;
}

/* ---------- rendering ---------- */
function render() {
  renderStats();
  renderList();
  renderBanner();
  const products = [...new Set(orders.flatMap(o => o.items.map(i => i.product)).filter(Boolean))].sort();
  $('#productList').innerHTML = products.map(p => `<option value="${esc(p)}">`).join('');
}

function renderStats() {
  const open = orders.filter(o => !CLOSED.has(o.status));
  const overdue = open.filter(o => urgency(o) === 'overdue').length;
  const soon = open.filter(o => urgency(o) === 'soon').length;
  const ready = open.filter(o => o.status === 'Ready').length;
  const pending = open.reduce((s, o) => s + Math.max(0, orderBalance(o)), 0);
  $('#stats').innerHTML = `
    <div class="stat" data-f="open"><div class="n">${open.length}</div><div class="l">Open orders</div></div>
    <div class="stat red" data-f="overdue"><div class="n">${overdue}</div><div class="l">Overdue</div></div>
    <div class="stat amber" data-f="soon"><div class="n">${soon}</div><div class="l">Due soon</div></div>
    <div class="stat green" data-f="Ready"><div class="n">${ready}</div><div class="l">Ready · ${money(pending)} to collect</div></div>`;
}

let quickFilter = null; // 'overdue' | 'soon' from stat tiles
function filtered() {
  const q = $('#search').value.trim().toLowerCase();
  const sf = $('#statusFilter').value;
  let list = orders.filter(o => {
    if (quickFilter) { if (urgency(o) !== quickFilter) return false; }
    else if (sf === 'open') { if (CLOSED.has(o.status)) return false; }
    else if (sf !== 'all' && o.status !== sf) return false;
    if (!q) return true;
    const hay = [o.orderNo, o.customer, o.phone, o.notes, ...o.items.flatMap(i => [i.product, i.details, i.personal, i.color, i.material])].join(' ').toLowerCase();
    return hay.includes(q);
  });
  const sort = $('#sortBy').value;
  list.sort((a, b) =>
    sort === 'created' ? b.createdAt.localeCompare(a.createdAt) :
    sort === 'customer' ? a.customer.localeCompare(b.customer) :
    a.dueDate.localeCompare(b.dueDate));
  return list;
}

function renderList() {
  const list = filtered();
  const el = $('#orderList');
  if (!list.length) {
    el.innerHTML = `<div class="empty">${orders.length ? 'No orders match.' : 'No orders yet.<br>Tap <b>+ New order</b> to add your first custom order.'}</div>`;
    return;
  }
  el.innerHTML = list.map(o => {
    const u = urgency(o), d = daysUntil(o.dueDate), bal = orderBalance(o);
    const items = o.items.map(i => `${esc(i.product)}${Number(i.qty) > 1 ? ' ×' + i.qty : ''}${i.personal ? ` <span class="meta">“${esc(i.personal)}”</span>` : ''}`).join(', ');
    return `<article class="order ${u}" data-id="${o.id}">
      <div class="order-top">
        <div><h3>${esc(o.customer)}</h3><div class="meta">${esc(o.orderNo)}${o.phone ? ' · ' + esc(o.phone) : ''}</div></div>
        <div class="due ${u}"><b>${CLOSED.has(o.status) ? esc(o.status) : dueText(d)}</b>${fmtDate(o.dueDate)}</div>
      </div>
      <div class="items">${items}</div>
      <div class="bottom">
        <span class="chip ${o.status.replace(' ', '-')}">${esc(o.status)}</span>
        ${o.priority !== 'Normal' ? `<span class="chip ${o.priority}">${o.priority}</span>` : ''}
        ${bal > 0 && o.status !== 'Cancelled' ? `<span class="chip due-bal">Balance ${money(bal)}</span>` : ''}
      </div>
    </article>`;
  }).join('');
}

function reminderList() {
  return orders.filter(o => ['overdue', 'soon'].includes(urgency(o)))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

function renderBanner() {
  const list = reminderList();
  const b = $('#reminderBanner');
  const count = $('#bellCount');
  count.hidden = !list.length; count.textContent = list.length;
  if (!list.length || lsGet('bastaa.bannerHidden', '') === todayISO() + ':' + list.length) { b.hidden = true; return; }
  b.hidden = false;
  b.innerHTML = `<h3>⏰ ${list.length} order${list.length > 1 ? 's' : ''} need attention</h3><ul>${list.map(o => {
    const d = daysUntil(o.dueDate);
    return `<li data-id="${o.id}"><span class="${d < 0 ? 'overdue' : ''}">${dueText(d)}</span> — ${esc(o.customer)}: ${esc(o.items.map(i => i.product).join(', '))} <span class="meta">(${esc(o.status)})</span></li>`;
  }).join('')}</ul>
  <div style="margin-top:8px"><button class="ghost small" id="hideBanner">Hide for today</button></div>`;
}

/* ---------- reminders & notifications ---------- */
function updateNotifState() {
  const s = !('Notification' in window) ? 'This browser does not support notifications.' :
    Notification.permission === 'granted' ? '✅ Notifications are on.' :
    Notification.permission === 'denied' ? '🚫 Notifications are blocked — allow them in your browser settings for this site.' :
    'Notifications are off.';
  $('#notifState').textContent = s;
  $('#enableNotifBtn').hidden = !('Notification' in window) || Notification.permission === 'granted';
}

async function notify(title, body, tag) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const opts = { body, tag, icon: 'icons/icon.svg', badge: 'icons/icon.svg' };
  try {
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if (reg) return reg.showNotification(title, opts);
  } catch {}
  try { new Notification(title, opts); } catch {}
}

function checkReminders() {
  renderBanner();
  const sent = lsGet('bastaa.notified', {});   // { orderId: 'YYYY-MM-DD' } — one alert per order per day
  const today = todayISO();
  for (const o of reminderList()) {
    if (sent[o.id] === today) continue;
    const d = daysUntil(o.dueDate);
    notify(`${dueText(d)}: ${o.customer}`, `${o.orderNo} · ${o.items.map(i => i.product).join(', ')} · ${o.status}`, o.id);
    sent[o.id] = today;
  }
  lsSet('bastaa.notified', sent);
}

/* ---------- calendar (.ics) ---------- */
function icsEvent(o) {
  const days = remindDaysFor(o);
  const d = o.dueDate.replace(/-/g, '');
  const end = parseISO(o.dueDate); end.setDate(end.getDate() + 1);
  const dEnd = `${end.getFullYear()}${pad(end.getMonth() + 1)}${pad(end.getDate())}`;
  const icsEsc = s => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, m => '\\' + m);
  const desc = [`Order ${o.orderNo}`, `Customer: ${o.customer} ${o.phone || ''}`, ...o.items.map(i => `• ${i.product} x${i.qty}: ${i.details}${i.personal ? ' | ' + i.personal : ''}`), `Balance: ${money(orderBalance(o))}`].join('\n');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const alarms = [days > 0 ? days : null, 0].filter(v => v !== null).map(n => [
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEsc(`${n ? n + ' days to due' : 'Due today'}: ${o.customer}`)}`,
    // all-day event starts at midnight: fire at 9am, n days before
    n ? `TRIGGER:-PT${n * 24 - 9}H` : 'TRIGGER:PT9H', 'END:VALARM'].join('\r\n'));
  return ['BEGIN:VEVENT', `UID:${o.id}@bastaa-orders`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${dEnd}`,
    `SUMMARY:${icsEsc(`Bastaa order due: ${o.customer} (${o.items.map(i => i.product).join(', ')})`)}`,
    `DESCRIPTION:${icsEsc(desc)}`, ...alarms, 'END:VEVENT'].join('\r\n');
}
function downloadICS(list, name) {
  const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Bastaa//Orders//EN', 'CALSCALE:GREGORIAN', ...list.map(icsEvent), 'END:VCALENDAR'].join('\r\n');
  download(name, body, 'text/calendar');
}
function download(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------- WhatsApp ---------- */
function waLink(o, text) {
  let p = String(o.phone || '').replace(/\D/g, '');
  if (p.length === 10) p = '91' + p;          // assume India for 10-digit numbers
  if (p.startsWith('0') && p.length === 11) p = '91' + p.slice(1);
  return p ? `https://wa.me/${p}?text=${encodeURIComponent(text)}` : null;
}
function waMessage(o) {
  const items = o.items.map(i => `${i.product}${Number(i.qty) > 1 ? ' x' + i.qty : ''}`).join(', ');
  const bal = orderBalance(o);
  const balLine = bal > 0 ? ` Balance payable: ${money(bal)}.` : '';
  const n = settings.businessName || 'Bastaa';
  switch (o.status) {
    case 'Ready': return `Hi ${o.customer}, your ${n} order ${o.orderNo} (${items}) is ready!${balLine} Thank you 😊`;
    case 'Delivered': return `Hi ${o.customer}, thank you for ordering from ${n}! We hope you love your ${items}. 💛`;
    case 'In Production': return `Hi ${o.customer}, your ${n} order ${o.orderNo} (${items}) is being made and is expected by ${fmtDate(o.dueDate)}.`;
    default: return `Hi ${o.customer}, we have received your ${n} order ${o.orderNo} (${items}). Expected by ${fmtDate(o.dueDate)}.${balLine}`;
  }
}

/* ---------- photos ---------- */
function resizeImage(file, max = 900) {
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      res(c.toDataURL('image/jpeg', 0.78));
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Could not read image')); };
    img.src = url;
  });
}
function openImage(src) {
  const w = window.open();
  if (w) { w.document.write(`<title>Photo</title><body style="margin:0;background:#111;display:grid;place-items:center;min-height:100vh"><img src="${src}" style="max-width:100%;max-height:100vh">`); w.document.close(); }
}

/* ---------- order form ---------- */
function addItemRow(item = {}) {
  const node = $('#itemTpl').content.firstElementChild.cloneNode(true);
  const idx = formPhotos.length;
  formPhotos.push([...(item.photos || [])]);
  node.dataset.idx = idx;
  $('.i-product', node).value = item.product || '';
  $('.i-qty', node).value = item.qty || 1;
  $('.i-price', node).value = item.price ?? '';
  $('.i-color', node).value = item.color || '';
  $('.i-size', node).value = item.size || '';
  $('.i-material', node).value = item.material || '';
  $('.i-personal', node).value = item.personal || '';
  $('.i-details', node).value = item.details || '';
  $('.remove-item', node).onclick = () => {
    if ($$('.item-card').length === 1) return toast('An order needs at least one product.');
    node.remove(); renumberItems(); updateTotals();
  };
  $('.i-photos', node).onchange = async e => {
    for (const f of e.target.files) {
      try { formPhotos[idx].push(await resizeImage(f)); } catch (err) { toast(err.message); }
    }
    e.target.value = ''; drawThumbs(node);
  };
  node.addEventListener('input', updateTotals);
  $('#itemsWrap').appendChild(node);
  drawThumbs(node); renumberItems();
}
function drawThumbs(node) {
  const idx = +node.dataset.idx;
  $('.thumbs', node).innerHTML = formPhotos[idx].map((src, i) => `<div class="thumb"><img src="${src}" alt="Reference ${i + 1}"><button type="button" data-i="${i}" aria-label="Remove photo">✕</button></div>`).join('');
  $$('.thumb button', node).forEach(b => b.onclick = () => { formPhotos[idx].splice(+b.dataset.i, 1); drawThumbs(node); });
  $$('.thumb img', node).forEach(img => img.onclick = () => openImage(img.src));
}
function renumberItems() { $$('.item-card').forEach((c, i) => $('.item-no', c).textContent = `Product ${i + 1}`); }
function readItems() {
  return $$('.item-card').map(c => ({
    product: $('.i-product', c).value.trim(), qty: Number($('.i-qty', c).value) || 1,
    price: $('.i-price', c).value === '' ? '' : Number($('.i-price', c).value),
    color: $('.i-color', c).value.trim(), size: $('.i-size', c).value.trim(), material: $('.i-material', c).value.trim(),
    personal: $('.i-personal', c).value.trim(), details: $('.i-details', c).value.trim(), photos: formPhotos[+c.dataset.idx],
  }));
}
function updateTotals() {
  const f = $('#orderForm');
  const total = readItems().reduce((s, i) => s + i.qty * (Number(i.price) || 0), 0);
  f.total.value = total;
  f.balance.value = money(total - (Number(f.advance.value) || 0));
}

function openForm(o = null) {
  editing = o; formPhotos = [];
  const f = $('#orderForm'); f.reset();
  $('#itemsWrap').innerHTML = '';
  $('#formTitle').textContent = o ? `Edit ${o.orderNo}` : 'New order';
  $('#deleteBtn').hidden = !o;
  const v = o || { orderDate: todayISO(), status: 'Received', priority: 'Normal', items: [{}] };
  for (const k of ['customer', 'phone', 'address', 'orderDate', 'dueDate', 'status', 'remindDays', 'priority', 'advance', 'notes'])
    f[k].value = v[k] ?? '';
  f.remindDays.placeholder = `Default (${settings.defaultRemindDays})`;
  v.items.forEach(addItemRow);
  updateTotals();
  $('#orderDialog').showModal();
  if (!o) f.customer.focus();
}

$('#orderForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  if (f.dueDate.value < f.orderDate.value) return toast('Due date is before the order date.');
  const now = new Date().toISOString();
  const data = {
    customer: f.customer.value.trim(), phone: f.phone.value.trim(), address: f.address.value.trim(),
    orderDate: f.orderDate.value, dueDate: f.dueDate.value, status: f.status.value,
    remindDays: f.remindDays.value === '' ? '' : Number(f.remindDays.value), priority: f.priority.value,
    advance: Number(f.advance.value) || 0, notes: f.notes.value.trim(), items: readItems(), updatedAt: now,
  };
  let o;
  if (editing) {
    o = { ...editing, ...data, history: [...(editing.history || [])] };
    if (editing.status !== o.status) o.history.push({ at: now, text: `Status → ${o.status}` });
    if (editing.dueDate !== o.dueDate) o.history.push({ at: now, text: `Due date changed to ${fmtDate(o.dueDate)}` });
  } else {
    o = { id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2),
      orderNo: nextOrderNo(), createdAt: now, history: [{ at: now, text: 'Order created' }], ...data };
  }
  try { await putOrder(o); } catch (err) { return toast('Could not save: ' + err.message); }
  const notified = lsGet('bastaa.notified', {}); delete notified[o.id]; lsSet('bastaa.notified', notified);
  $('#orderDialog').close();
  toast(editing ? 'Order updated' : `Order ${o.orderNo} saved`);
  await load();
});

$('#deleteBtn').onclick = async () => {
  if (!editing || !confirm(`Delete order ${editing.orderNo} for ${editing.customer}? This cannot be undone.`)) return;
  await delOrder(editing.id);
  $('#orderDialog').close(); toast('Order deleted'); load();
};
$('#addItemBtn').onclick = () => addItemRow();
$('#orderForm').advance.addEventListener('input', updateTotals);

/* ---------- order detail view ---------- */
function openView(id) {
  const o = orders.find(x => x.id === id); if (!o) return;
  const u = urgency(o), d = daysUntil(o.dueDate);
  $('#viewTitle').textContent = `${o.orderNo} · ${o.customer}`;
  const row = (k, v) => v || v === 0 ? `<dt>${k}</dt><dd>${esc(v)}</dd>` : '';
  $('#viewBody').innerHTML = `
    <div class="view-section">
      <div class="status-row">${STATUSES.map(s => `<button class="${s === o.status ? 'primary' : 'ghost'} small" data-status="${s}">${s}</button>`).join('')}</div>
    </div>
    <div class="view-section"><h4>Due</h4>
      <div class="due ${u}" style="text-align:left"><b>${CLOSED.has(o.status) ? esc(o.status) : dueText(d)}</b>${fmtDate(o.dueDate)} · ordered ${fmtDate(o.orderDate)} · reminder ${remindDaysFor(o)} day(s) before</div>
    </div>
    <div class="view-section"><h4>Customer</h4><dl class="kv">${row('Name', o.customer)}${row('Phone', o.phone)}${row('Address', o.address)}</dl></div>
    <div class="view-section"><h4>Products</h4>${o.items.map((i, n) => `
      <div class="view-item"><strong>${n + 1}. ${esc(i.product)}</strong> × ${i.qty}${i.price !== '' ? ` @ ${money(i.price)}` : ''}
        <dl class="kv" style="margin-top:6px">${row('Colour', i.color)}${row('Size', i.size)}${row('Material', i.material)}${row('Personalization', i.personal)}${row('Details', i.details)}</dl>
        ${i.photos?.length ? `<div class="thumbs" style="margin-top:8px">${i.photos.map(p => `<img src="${p}" alt="Reference photo">`).join('')}</div>` : ''}
      </div>`).join('')}
    </div>
    <div class="view-section"><h4>Payment</h4><dl class="kv">${row('Total', money(orderTotal(o)))}${row('Advance', money(o.advance))}<dt>Balance</dt><dd><b>${money(orderBalance(o))}</b></dd></dl></div>
    ${o.notes ? `<div class="view-section"><h4>Notes</h4><div style="white-space:pre-wrap">${esc(o.notes)}</div></div>` : ''}
    <div class="view-section"><h4>History</h4><ul class="history">${(o.history || []).map(h => `<li>${new Date(h.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })} — ${esc(h.text)}</li>`).join('')}</ul></div>`;
  const wa = waLink(o, waMessage(o));
  $('#viewFoot').innerHTML = `
    ${wa ? `<a class="link-btn" href="${wa}" target="_blank" rel="noopener">💬 WhatsApp update</a>` : ''}
    <button class="ghost small" id="icsOne">📅 Add to calendar</button>
    <button class="ghost small" id="printOne">🖨 Job sheet</button>
    <span class="spacer"></span>
    <button class="primary small" id="editOne">Edit</button>`;
  $$('#viewBody [data-status]').forEach(b => b.onclick = async () => {
    if (b.dataset.status === o.status) return;
    const now = new Date().toISOString();
    const upd = { ...o, status: b.dataset.status, updatedAt: now, history: [...(o.history || []), { at: now, text: `Status → ${b.dataset.status}` }] };
    await putOrder(upd); await load(); openView(o.id); toast(`Marked ${b.dataset.status}`);
  });
  $$('#viewBody .view-item img').forEach(img => img.onclick = () => openImage(img.src));
  $('#icsOne').onclick = () => downloadICS([o], `${o.orderNo}.ics`);
  $('#printOne').onclick = () => printJobSheet(o);
  $('#editOne').onclick = () => { $('#viewDialog').close(); openForm(o); };
  if (!$('#viewDialog').open) $('#viewDialog').showModal();
}

function printJobSheet(o) {
  const w = window.open('', '_blank'); if (!w) return toast('Allow pop-ups to print.');
  w.document.write(`<!doctype html><title>${esc(o.orderNo)}</title><style>
    body{font:14px system-ui,sans-serif;margin:24px;color:#000} h1{margin:0 0 4px} table{border-collapse:collapse;width:100%;margin:10px 0}
    td,th{border:1px solid #999;padding:6px;text-align:left;vertical-align:top} img{width:120px;height:120px;object-fit:cover;margin:4px;border:1px solid #ccc}
  </style><h1>${esc(settings.businessName)} — Job sheet ${esc(o.orderNo)}</h1>
  <p><b>Customer:</b> ${esc(o.customer)} ${esc(o.phone)}<br><b>Ordered:</b> ${fmtDate(o.orderDate)} &nbsp; <b>DUE:</b> ${fmtDate(o.dueDate)} &nbsp; <b>Priority:</b> ${esc(o.priority)}</p>
  ${o.items.map((i, n) => `<table><tr><th colspan="2">${n + 1}. ${esc(i.product)} × ${i.qty}</th></tr>
    <tr><td width="160">Colour</td><td>${esc(i.color)}</td></tr><tr><td>Size</td><td>${esc(i.size)}</td></tr>
    <tr><td>Material</td><td>${esc(i.material)}</td></tr><tr><td>Personalization</td><td>${esc(i.personal)}</td></tr>
    <tr><td>Details</td><td style="white-space:pre-wrap">${esc(i.details)}</td></tr>
    ${i.photos?.length ? `<tr><td>Reference</td><td>${i.photos.map(p => `<img src="${p}">`).join('')}</td></tr>` : ''}</table>`).join('')}
  ${o.notes ? `<p><b>Notes:</b> ${esc(o.notes)}</p>` : ''}
  <script>onload=()=>print()<\/script>`);
  w.document.close();
}

/* ---------- settings / backup ---------- */
function openSettings() {
  const f = $('#settingsForm');
  for (const k of Object.keys(DEFAULT_SETTINGS)) f[k].value = settings[k];
  updateNotifState();
  $('#settingsDialog').showModal();
}
$('#settingsForm').addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target;
  settings = { defaultRemindDays: Math.max(0, Number(f.defaultRemindDays.value) || 0), businessName: f.businessName.value.trim() || 'Bastaa', prefix: f.prefix.value.trim() || 'BST' };
  lsSet('bastaa.settings', settings);
  $('#settingsDialog').close(); toast('Settings saved'); render(); checkReminders();
});
$('#enableNotifBtn').onclick = async () => {
  if (!('Notification' in window)) return;
  const p = await Notification.requestPermission();
  updateNotifState();
  if (p === 'granted') { lsSet('bastaa.notified', {}); checkReminders(); toast('Notifications enabled'); }
};
$('#icsAllBtn').onclick = () => {
  const open = orders.filter(o => !CLOSED.has(o.status));
  if (!open.length) return toast('No open orders to export.');
  downloadICS(open, `bastaa-orders-${todayISO()}.ics`);
};
$('#exportBtn').onclick = () => download(`bastaa-backup-${todayISO()}.json`, JSON.stringify({ app: 'bastaa-orders', version: 1, exportedAt: new Date().toISOString(), settings, orders }, null, 1), 'application/json');
$('#importFile').onchange = async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'bastaa-orders' || !Array.isArray(data.orders)) throw new Error('This is not a Bastaa backup file.');
    const replace = confirm(`Backup has ${data.orders.length} orders.\n\nOK = replace all current orders\nCancel = merge (keep current, add/update from backup)`);
    if (replace) await clearAll();
    for (const o of data.orders) await putOrder(o);
    if (data.settings) { settings = { ...DEFAULT_SETTINGS, ...data.settings }; lsSet('bastaa.settings', settings); }
    $('#settingsDialog').close(); toast(`Restored ${data.orders.length} orders`); load();
  } catch (err) { toast('Restore failed: ' + err.message); }
};
$('#csvBtn').onclick = () => {
  const cols = ['Order No', 'Customer', 'Phone', 'Order Date', 'Due Date', 'Status', 'Priority', 'Product', 'Qty', 'Price', 'Colour', 'Size', 'Material', 'Personalization', 'Details', 'Order Total', 'Advance', 'Balance', 'Notes'];
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = orders.flatMap(o => o.items.map(i => [o.orderNo, o.customer, o.phone, o.orderDate, o.dueDate, o.status, o.priority, i.product, i.qty, i.price, i.color, i.size, i.material, i.personal, i.details, orderTotal(o), o.advance, orderBalance(o), o.notes]));
  download(`bastaa-orders-${todayISO()}.csv`, '\ufeff' + [cols, ...rows].map(r => r.map(q).join(',')).join('\r\n'), 'text/csv');
};

/* ---------- misc UI ---------- */
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 2800); }

$$('dialog').forEach(d => d.addEventListener('click', e => { if (e.target.closest('[data-close]')) d.close(); }));
$('#newOrderBtn').onclick = () => openForm();
$('#settingsBtn').onclick = openSettings;
$('#bellBtn').onclick = () => { lsSet('bastaa.bannerHidden', ''); quickFilter = null; renderBanner(); if (!reminderList().length) toast('No upcoming reminders 🎉'); window.scrollTo({ top: 0, behavior: 'smooth' }); };
$('#search').oninput = () => renderList();
$('#statusFilter').onchange = () => { quickFilter = null; renderList(); };
$('#sortBy').onchange = renderList;
$('#orderList').onclick = e => { const c = e.target.closest('.order'); if (c) openView(c.dataset.id); };
$('#reminderBanner').onclick = e => {
  if (e.target.id === 'hideBanner') { lsSet('bastaa.bannerHidden', todayISO() + ':' + reminderList().length); renderBanner(); return; }
  const li = e.target.closest('li[data-id]'); if (li) openView(li.dataset.id);
};
$('#stats').onclick = e => {
  const s = e.target.closest('.stat'); if (!s) return;
  const f = s.dataset.f;
  if (f === 'overdue' || f === 'soon') { quickFilter = quickFilter === f ? null : f; $('#statusFilter').value = 'open'; }
  else { quickFilter = null; $('#statusFilter').value = f; }
  renderList();
};

// Re-check reminders when the app comes back to the foreground and every 30 minutes while open.
document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); checkReminders(); } });
setInterval(() => { render(); checkReminders(); }, 30 * 60 * 1000);

if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

load().catch(err => { $('#orderList').innerHTML = `<div class="empty">Could not open storage: ${esc(err.message)}</div>`; });
