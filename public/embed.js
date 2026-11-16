/*
 * Stock Manager — website embed.
 *
 *   <script src="https://YOUR-STOCK-SERVER/embed.js" data-key="pk_..." defer></script>
 *
 * Then mark up elements:
 *   <span data-stock-sku="SKU-1"></span>                       -> "12 in stock" / "Only 2 left" / "Out of stock"
 *   <span data-stock-sku="SKU-1" data-stock-format="number"></span>  -> "12"
 *   <button data-stock-sku="SKU-1" data-stock-disable-when-out>Add to cart</button>
 *   <div data-stock-sku="SKU-1" data-stock-hide-when-out>…</div>
 *
 * Elements get classes stock-in / stock-low / stock-out so you can style them.
 * Stock updates live (Server-Sent Events, with polling fallback).
 * JS API: window.StockSync.get('SKU-1'), StockSync.on('change', fn), StockSync.refresh()
 */
(function () {
  'use strict';
  var script = document.currentScript || document.querySelector('script[src*="embed.js"][data-key]');
  if (!script) return;
  var key = script.getAttribute('data-key');
  var base = script.getAttribute('data-api') || new URL(script.src, location.href).origin;
  var pollMs = Number(script.getAttribute('data-poll-seconds') || 60) * 1000;
  var stock = {};
  var listeners = [];

  var text = {
    out: script.getAttribute('data-text-out') || 'Out of stock',
    low: script.getAttribute('data-text-low') || 'Only {n} left',
    in: script.getAttribute('data-text-in') || '{n} in stock',
  };

  function skusOnPage() {
    var set = {};
    document.querySelectorAll('[data-stock-sku]').forEach(function (el) { set[el.getAttribute('data-stock-sku')] = 1; });
    return Object.keys(set);
  }

  function render() {
    document.querySelectorAll('[data-stock-sku]').forEach(function (el) {
      var s = stock[el.getAttribute('data-stock-sku')];
      var qty = s ? s.quantity : 0;
      var status = !s || qty <= 0 ? 'out' : s.low_stock ? 'low' : 'in';
      el.classList.remove('stock-in', 'stock-low', 'stock-out');
      el.classList.add('stock-' + status);
      el.setAttribute('data-stock-quantity', String(qty));
      if (el.hasAttribute('data-stock-disable-when-out')) { el.disabled = status === 'out'; return; }
      if (el.hasAttribute('data-stock-hide-when-out')) { el.style.display = status === 'out' ? 'none' : ''; return; }
      var fmt = el.getAttribute('data-stock-format');
      el.textContent = fmt === 'number' ? String(Math.max(qty, 0)) : text[status].replace('{n}', qty);
    });
  }

  function emit(sku) { listeners.forEach(function (fn) { try { fn(sku, stock[sku]); } catch (e) { console.error(e); } }); }

  function refresh() {
    var skus = skusOnPage();
    var url = base + '/api/v1/stock?key=' + encodeURIComponent(key) + (skus.length ? '&skus=' + encodeURIComponent(skus.join(',')) : '');
    return fetch(url).then(function (r) { return r.json(); }).then(function (data) {
      if (data && data.stock) {
        stock = data.stock; render();
        Object.keys(stock).forEach(emit);
      }
    }).catch(function (e) { console.warn('[StockSync] could not load stock', e); });
  }

  function live() {
    if (!window.EventSource) return setInterval(refresh, pollMs);
    var es = new EventSource(base + '/api/v1/events?key=' + encodeURIComponent(key));
    es.addEventListener('stock.updated', function (ev) {
      var p = JSON.parse(ev.data).data.product;
      stock[p.sku] = { quantity: p.quantity, in_stock: p.in_stock, low_stock: p.low_stock, price: p.price };
      render(); emit(p.sku);
    });
    ['product.updated', 'product.created', 'product.deleted'].forEach(function (n) { es.addEventListener(n, refresh); });
    es.onopen = refresh; // resync after reconnects
    setInterval(refresh, Math.max(pollMs, 5 * 60 * 1000)); // safety net
  }

  window.StockSync = {
    get: function (sku) { return stock[sku]; },
    all: function () { return stock; },
    on: function (_evt, fn) { listeners.push(fn); },
    refresh: refresh,
    render: render,
  };

  function start() { refresh().then(live); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
