/**
 * Bastaa Orders ⇄ Google Sheets ⇄ WhatsApp — free connector (Google Apps Script).
 *
 * What it does
 *  1. Receives your orders from the Bastaa Orders app and writes them to the "Orders" tab,
 *     one row per order, with a live "Days left" column and a one-click WhatsApp link per order.
 *  2. (Optional) Receives WhatsApp messages from customers through the free WhatsApp Cloud API
 *     and logs them in the "WhatsApp Inbox" tab, matched to their orders by phone number.
 *  3. (Optional) Lets you reply on WhatsApp from the sheet: select a row → Bastaa menu → Reply.
 *
 * Setup: see google-sheets/README.md. In short: paste this file into Extensions → Apps Script
 * of a Google Sheet, run `setup` once, then Deploy → New deployment → Web app
 * (Execute as: Me, Who has access: Anyone) and copy the URL and secret key into the app.
 */

const ORDERS_TAB = 'Orders';
const INBOX_TAB = 'WhatsApp Inbox';
const GRAPH_VERSION = 'v21.0';

const ORDER_HEADERS = ['Order No', 'Customer', 'Phone', 'Order Date', 'Due Date', 'Days Left', 'Status', 'Priority',
  'Products', 'Total', 'Advance', 'Balance', 'Address', 'Notes', 'Last Updated', 'WhatsApp', 'Order ID'];
const INBOX_HEADERS = ['Received', 'From', 'Name', 'Type', 'Message', 'Matching Orders', 'Direction', 'Message ID'];

const props = () => PropertiesService.getScriptProperties();

/* ---------------- one-time setup (run from the editor) ---------------- */
function setup() {
  const ss = SpreadsheetApp.getActive();
  ensureTab_(ss, ORDERS_TAB, ORDER_HEADERS);
  ensureTab_(ss, INBOX_TAB, INBOX_HEADERS);
  const p = props();
  if (!p.getProperty('APP_SECRET')) p.setProperty('APP_SECRET', Utilities.getUuid().replace(/-/g, '').slice(0, 20));
  if (!p.getProperty('WA_VERIFY_TOKEN')) p.setProperty('WA_VERIFY_TOKEN', 'bastaa-' + Utilities.getUuid().slice(0, 8));
  const msg = 'Setup done.\n\nSecret key for the Bastaa app:\n' + p.getProperty('APP_SECRET') +
    '\n\nWhatsApp webhook verify token (only if you use the WhatsApp Cloud API):\n' + p.getProperty('WA_VERIFY_TOKEN') +
    '\n\nNext: Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).';
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* run without a UI */ }
}

/** Optional: run once to store your WhatsApp Cloud API details (only needed for replying from the sheet). */
function setWhatsAppCredentials() {
  const ui = SpreadsheetApp.getUi();
  const id = ui.prompt('WhatsApp Cloud API', 'Phone number ID (Meta → WhatsApp → API Setup):', ui.ButtonSet.OK_CANCEL);
  if (id.getSelectedButton() !== ui.Button.OK) return;
  const tok = ui.prompt('WhatsApp Cloud API', 'Access token (use a permanent System User token):', ui.ButtonSet.OK_CANCEL);
  if (tok.getSelectedButton() !== ui.Button.OK) return;
  props().setProperties({ WA_PHONE_NUMBER_ID: id.getResponseText().trim(), WA_TOKEN: tok.getResponseText().trim() });
  ui.alert('Saved. You can now reply from the sheet.');
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Bastaa')
    .addItem('Reply on WhatsApp to selected row', 'replyToSelectedRow')
    .addSeparator()
    .addItem('Show secret key & verify token', 'setup')
    .addItem('Set WhatsApp API credentials', 'setWhatsAppCredentials')
    .addToUi();
}

/* ---------------- web app endpoints ---------------- */
function doGet(e) {
  const p = (e && e.parameter) || {};
  // WhatsApp Cloud API webhook verification
  if (p['hub.mode'] === 'subscribe') {
    return text_(p['hub.verify_token'] === props().getProperty('WA_VERIFY_TOKEN') ? p['hub.challenge'] : 'Verify token does not match');
  }
  return text_('Bastaa Sheets connector is running.');
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'Bad request' }); }

  // Incoming WhatsApp Cloud API webhook
  if (body.object === 'whatsapp_business_account') {
    withLock_(() => logWhatsApp_(body));
    return text_('EVENT_RECEIVED');
  }

  // Requests from the Bastaa Orders app
  if (!body.secret || body.secret !== props().getProperty('APP_SECRET')) return json_({ ok: false, error: 'Wrong secret key' });
  if (body.action === 'ping') return json_({ ok: true, sheet: SpreadsheetApp.getActive().getName() });
  if (body.action === 'sync') {
    const n = withLock_(() => writeOrders_(body.orders || []));
    return json_({ ok: true, count: n, at: new Date().toISOString() });
  }
  return json_({ ok: false, error: 'Unknown action' });
}

/* ---------------- orders ---------------- */
function writeOrders_(orders) {
  const sh = ensureTab_(SpreadsheetApp.getActive(), ORDERS_TAB, ORDER_HEADERS);
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, sh.getLastColumn()).clearContent();
  if (!orders.length) return 0;

  orders.sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
  const rows = orders.map((o, i) => {
    const r = i + 2;
    const closed = o.status === 'Delivered' || o.status === 'Cancelled';
    return [
      o.orderNo, o.customer, "'" + (o.phone || ''), dateOrBlank_(o.orderDate), dateOrBlank_(o.dueDate),
      closed || !o.dueDate ? '' : `=E${r}-TODAY()`,
      o.status, o.priority, o.products, o.total, o.advance, o.balance, o.address, o.notes,
      o.updatedAt ? new Date(o.updatedAt) : '',
      o.waLink ? `=HYPERLINK("${String(o.waLink).replace(/"/g, '""')}","💬 Send update")` : '',
      o.id,
    ];
  });
  sh.getRange(2, 1, rows.length, ORDER_HEADERS.length).setValues(rows);
  sh.getRange(2, 4, rows.length, 2).setNumberFormat('d mmm yyyy');
  sh.getRange(2, 10, rows.length, 3).setNumberFormat('₹#,##0.##');
  sh.getRange(2, 15, rows.length, 1).setNumberFormat('d mmm yyyy, h:mm am/pm');
  sh.getRange(2, 9, rows.length, 1).setWrap(true);
  return rows.length;
}

/* ---------------- WhatsApp inbox ---------------- */
function logWhatsApp_(body) {
  const sh = ensureTab_(SpreadsheetApp.getActive(), INBOX_TAB, INBOX_HEADERS);
  const seen = new Set(sh.getLastRow() > 1 ? sh.getRange(2, 8, sh.getLastRow() - 1, 1).getValues().flat().map(String) : []);
  const ordersByPhone = orderIndexByPhone_();
  const out = [];
  (body.entry || []).forEach(en => (en.changes || []).forEach(ch => {
    const v = ch.value || {};
    const names = {};
    (v.contacts || []).forEach(c => names[c.wa_id] = c.profile && c.profile.name);
    (v.messages || []).forEach(m => {
      if (seen.has(m.id)) return;  // WhatsApp may resend the same event
      seen.add(m.id);
      out.push([new Date(Number(m.timestamp) * 1000), "'" + m.from, names[m.from] || '', m.type, messageText_(m),
        (ordersByPhone[last10_(m.from)] || []).join(', '), 'Incoming', m.id]);
    });
  }));
  if (out.length) sh.getRange(sh.getLastRow() + 1, 1, out.length, INBOX_HEADERS.length).setValues(out);
}

function messageText_(m) {
  switch (m.type) {
    case 'text': return m.text.body;
    case 'button': return m.button.text;
    case 'interactive': return JSON.stringify(m.interactive.button_reply || m.interactive.list_reply || m.interactive);
    case 'location': return `Location: ${m.location.latitude},${m.location.longitude} ${m.location.name || ''}`;
    case 'image': case 'video': case 'document': case 'audio': case 'sticker':
      return `[${m.type}] ${(m[m.type] && m[m.type].caption) || ''}`.trim();
    default: return `[${m.type}]`;
  }
}

function orderIndexByPhone_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(ORDERS_TAB);
  const idx = {};
  if (!sh || sh.getLastRow() < 2) return idx;
  sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues().forEach(r => {
    const k = last10_(r[2]);
    if (k && r[0]) (idx[k] = idx[k] || []).push(`${r[0]} (${r[6]})`);
  });
  return idx;
}

/* ---------------- reply from the sheet ---------------- */
function replyToSelectedRow() {
  const ui = SpreadsheetApp.getUi();
  const p = props();
  if (!p.getProperty('WA_TOKEN') || !p.getProperty('WA_PHONE_NUMBER_ID')) {
    return ui.alert('Set your WhatsApp API credentials first (Bastaa menu → Set WhatsApp API credentials).\n\nNo API? Use the "💬 Send update" links in the Orders tab instead — they open WhatsApp with the message ready.');
  }
  const sh = SpreadsheetApp.getActiveSheet();
  const row = sh.getActiveRange().getRow();
  if (row < 2) return ui.alert('Select a data row first.');
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const col = headers.indexOf(sh.getName() === INBOX_TAB ? 'From' : 'Phone');
  if (col < 0) return ui.alert('Use this on the Orders or WhatsApp Inbox tab.');
  const to = toWaNumber_(sh.getRange(row, col + 1).getValue());
  if (!to) return ui.alert('No phone number in this row.');
  const res = ui.prompt('Reply on WhatsApp to +' + to, 'Message:', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK || !res.getResponseText().trim()) return;
  const msg = res.getResponseText().trim();

  const r = UrlFetchApp.fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${p.getProperty('WA_PHONE_NUMBER_ID')}/messages`, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + p.getProperty('WA_TOKEN') },
    payload: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: msg } }),
  });
  const data = JSON.parse(r.getContentText() || '{}');
  if (r.getResponseCode() >= 300) {
    const err = (data.error && (data.error.error_data && data.error.error_data.details || data.error.message)) || r.getContentText();
    return ui.alert('WhatsApp did not send the message:\n\n' + err +
      '\n\nNote: free-form replies only work within 24 hours of the customer\'s last message. Outside that window, use the "💬 Send update" link.');
  }
  const inbox = ensureTab_(SpreadsheetApp.getActive(), INBOX_TAB, INBOX_HEADERS);
  inbox.appendRow([new Date(), "'" + to, '', 'text', msg, (orderIndexByPhone_()[last10_(to)] || []).join(', '), 'Outgoing',
    (data.messages && data.messages[0] && data.messages[0].id) || '']);
  ui.alert('Sent ✅');
}

/* ---------------- helpers ---------------- */
function ensureTab_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getRange(1, 1).getValue() !== headers[0]) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#f3e8d8');
    sh.setFrozenRows(1);
  }
  return sh;
}
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}
function dateOrBlank_(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d);
}
function last10_(phone) { const d = String(phone || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; }
function toWaNumber_(phone) {
  let p = String(phone || '').replace(/\D/g, '');
  if (p.length === 10) p = '91' + p;                       // same rule as the app: 10 digits = India
  if (p.length === 11 && p.startsWith('0')) p = '91' + p.slice(1);
  return p;
}
function text_(s) { return ContentService.createTextOutput(String(s)); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
