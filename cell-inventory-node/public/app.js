'use strict';
/* Cell Inventory & Sales System - front end (plain JavaScript, no build step) */

// ================================================================ helpers
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => 'Rs ' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num0 = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const today = () => new Date().toLocaleDateString('en-CA');

const store = {
  get token() { try { return localStorage.getItem('cis_token'); } catch { return null; } },
  set token(v) { try { v ? localStorage.setItem('cis_token', v) : localStorage.removeItem('cis_token'); } catch { /* ignore */ } },
};
let user = null;

async function api(method, url, body) {
  const res = await fetch('/api' + url, {
    method, headers: { 'Content-Type': 'application/json', ...(store.token ? { Authorization: 'Bearer ' + store.token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/login') { store.token = null; user = null; showLogin(); throw new Error(data.error || 'Please log in.'); }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function toast(msg, kind = 'ok') {
  const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = msg;
  $('#toast-root').appendChild(t); setTimeout(() => t.remove(), 3500);
}
const fail = (e) => toast(e.message, 'error');

function modal(title, html, buttons = [{ text: 'Close' }]) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    root.innerHTML = `<div class="overlay"><div class="modal" role="dialog"><h3>${esc(title)}</h3><div>${html}</div>
      <div class="actions">${buttons.map((b, i) => `<button class="btn ${b.cls || 'light'}" data-i="${i}">${esc(b.text)}</button>`).join('')}</div></div></div>`;
    const close = (v) => { root.innerHTML = ''; resolve(v); };
    $$('.actions button', root).forEach((b) => b.addEventListener('click', () => close(buttons[+b.dataset.i].value ?? false)));
    $('.overlay', root).addEventListener('mousedown', (e) => { if (e.target.classList.contains('overlay')) close(false); });
  });
}
const confirmBox = (msg) => modal('Please confirm', `<p>${esc(msg)}</p>`, [{ text: 'Cancel', value: false }, { text: 'Yes, continue', cls: 'red', value: true }]);

/** Builds an HTML table. cols: [{h, v:(row)=>html, num?:bool}] */
function table(cols, rows, { rowClass, empty = 'Nothing to show.' } = {}) {
  if (!rows.length) return `<div class="tbl-wrap"><div class="empty">${esc(empty)}</div></div>`;
  return `<div class="tbl-wrap"><table><thead><tr>${cols.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r, i) => `<tr data-i="${i}" class="${rowClass ? rowClass(r) : ''}">${cols.map((c) => `<td class="${c.num ? 'num' : ''}">${c.v(r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
const head = (t, s) => `<div class="page-head"><h1>${esc(t)}</h1><p>${esc(s)}</p></div>`;
const field = (label, inner, cls = '') => `<label class="f ${cls}">${esc(label)}${inner}</label>`;

// ================================================================ login
function showLogin() {
  $('#app').innerHTML = `
  <div class="login">
    <div class="login-left">
      <h1>Cell Inventory<br>&amp; Sales System</h1>
      <p>Phones, accessories, stock, purchases, sales, invoices and reports in one place.</p>
      <ul><li>Real-time stock &amp; low-stock alerts</li><li>Fast billing with printable invoices</li><li>Daily &amp; monthly business reports</li></ul>
    </div>
    <div class="login-right"><form class="login-box" id="login-form">
      <h2>Welcome back</h2><p class="muted">Sign in to continue</p>
      ${field('Username', '<input id="lu" autocomplete="username" autofocus>')}
      ${field('Password', '<input id="lp" type="password" autocomplete="current-password">')}
      <div class="err" id="lerr"></div>
      <button class="btn block">Sign in</button>
      <p class="muted">Demo: <b>admin / admin123</b> &nbsp;|&nbsp; <b>staff / staff123</b></p>
    </form></div>
  </div>`;
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault(); $('#lerr').textContent = '';
    if (!$('#lu').value.trim() || !$('#lp').value) { $('#lerr').textContent = 'Enter username and password.'; return; }
    try {
      const r = await api('POST', '/login', { username: $('#lu').value, password: $('#lp').value });
      store.token = r.token; user = r.user; showShell();
    } catch (err) { $('#lerr').textContent = err.message; }
  });
}

// ================================================================ shell + routing
const ROUTES = [
  { id: 'dashboard', label: 'Dashboard', view: dashboardView },
  { id: 'products', label: 'Products', view: productsView },
  { id: 'inventory', label: 'Inventory', view: inventoryView },
  { id: 'purchases', label: 'Purchases', view: purchasesView, perm: 'purchases' },
  { id: 'sales', label: 'Sales & Invoices', view: salesView },
  { id: 'customers', label: 'Customers', view: () => partyView('customers', 'Customer') },
  { id: 'suppliers', label: 'Suppliers', view: () => partyView('suppliers', 'Supplier'), perm: 'purchases' },
  { id: 'reports', label: 'Reports', view: reportsView, perm: 'reports' },
  { id: 'users', label: 'Users', view: usersView, perm: 'users' },
];
const allowed = () => ROUTES.filter((r) => !r.perm || user.permissions[r.perm]);

function showShell() {
  $('#app').innerHTML = `<div class="shell">
    <aside class="sidebar">
      <div class="brand"><b>Cell Inventory</b><span>&amp; Sales System</span></div>
      <nav class="nav">${allowed().map((r) => `<button data-r="${r.id}">${esc(r.label)}</button>`).join('')}</nav>
      <div class="who"><b>${esc(user.fullName)}</b><span>${user.role === 'ADMIN' ? 'Administrator' : 'Sales Staff'}</span>
        <button class="btn light block" id="logout" style="margin-top:10px">Log out</button></div>
    </aside><main class="main" id="main"></main></div>`;
  $$('.nav button').forEach((b) => b.addEventListener('click', () => { location.hash = b.dataset.r; }));
  $('#logout').addEventListener('click', async () => { try { await api('POST', '/logout', {}); } catch { /* ignore */ } store.token = null; user = null; showLogin(); });
  route();
}
async function route() {
  if (!user) return;
  const id = location.hash.slice(1) || 'dashboard';
  const r = allowed().find((x) => x.id === id) || allowed()[0];
  $$('.nav button').forEach((b) => b.classList.toggle('active', b.dataset.r === r.id));
  const main = $('#main'); main.innerHTML = '<p class="muted">Loading...</p>';
  try { await r.view(main); } catch (e) { fail(e); }
}
window.addEventListener('hashchange', route);

// ================================================================ dashboard
// ================================================================ dashboard
async function dashboardView(main) {
  const d = await api('GET', '/dashboard');

  const today = d.today || {};
  const products = d.products || {};
  const last7 = Array.isArray(d.sales_chart) ? d.sales_chart : [];

  const max = Math.max(1, ...last7.map((x) => Number(x.total) || 0));

  main.innerHTML = head(
    'Dashboard',
    `Welcome, ${user.fullName} - here is how the shop is doing today.`
  ) + `
  <div class="stats">
    <div class="card stat">
      <small>Today's Sales</small>
      <b class="c-green">${money(today.revenue || 0)}</b>
    </div>

    <div class="card stat">
      <small>Invoices Today</small>
      <b class="c-blue">${today.transactions || 0}</b>
    </div>

    <div class="card stat">
      <small>Today's Discounts</small>
      <b class="c-purple">${money(today.discounts || 0)}</b>
    </div>

    <div class="card stat">
      <small>Products</small>
      <b class="c-blue">${products.total_products || 0}</b>
    </div>

    <div class="card stat">
      <small>Low Stock Items</small>
      <b class="${products.low_stock ? 'c-red' : 'c-green'}">
        ${products.low_stock || 0}
      </b>
    </div>

    <div class="card stat">
      <small>Stock Value</small>
      <b class="c-orange">${money(products.stock_value || 0)}</b>
    </div>
  </div>

  <div class="grid2">
    <div class="card">
      <h3>Sales - Last 7 Days</h3>
      <div class="bars">
        ${last7.map((x) => {
          const total = Number(x.total) || 0;
          return `
            <div class="bar" title="${esc(x.date)}: ${money(total)}">
              <em>${total ? num0(total) : ''}</em>
              <i style="height:${Math.max(1, (total / max) * 150)}px"></i>
              ${esc(x.date.slice(5))}
            </div>
          `;
        }).join('')}
      </div>
    </div>

    <div class="stack">
      <div class="card">
        <h3>Inventory Summary</h3>
        <p>Total Stock Units: <b>${products.total_units || 0}</b></p>
        <p>Customers: <b>${d.customers || 0}</b></p>
        <p>Today's Purchases: <b>${money(d.purchases_today || 0)}</b></p>
      </div>
    </div>
  </div>`;
}


// ================================================================ products
async function productsView(main) {
  const canEdit = user.permissions.products;
  let list = [], selected = null, q = '';
  const suppliers = canEdit ? await api('GET', '/suppliers') : [];
  main.innerHTML = head('Products', canEdit ? 'Manage phones and accessories' : 'Browse phones and accessories (read-only for sales staff)') + `
  <div class="${canEdit ? 'grid-side' : ''}">
    <div class="stack">
      <div class="row"><input id="pq" class="grow" placeholder="Search by name, SKU, brand, category..."><button class="btn" id="psearch">Search</button><button class="btn light" id="pall">Show all</button></div>
      <div id="ptable"></div>
    </div>
    ${canEdit ? `<div class="card"><h3 id="ptitle">New product</h3><form id="pform" class="form-grid">
      ${field('SKU *', '<input name="sku" required>')}
      ${field('Type', '<select name="type"><option value="PHONE">Phone</option><option value="ACCESSORY">Accessory</option></select>')}
      ${field('Name *', '<input name="name" required>', 'full')}
      ${field('Category', '<input name="category" placeholder="e.g. Smartphone, Charger">', 'full')}
      ${field('Purchase price *', '<input name="purchase_price" type="number" min="0" step="0.01" required>')}
      ${field('Sale price *', '<input name="sale_price" type="number" min="0" step="0.01" required>')}
      ${field('Quantity in stock', '<input name="quantity" type="number" min="0" step="1" value="0">')}
      ${field('Minimum stock level', '<input name="min_stock" type="number" min="0" step="1" value="5">')}
      ${field('Supplier', `<select name="supplier_id"><option value="">-</option>${suppliers.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>`, 'full')}
      <div class="full form-grid" id="phone-fields">
        ${field('Brand', '<input name="brand">')}${field('Model', '<input name="model">')}${field('RAM', '<input name="ram" placeholder="8GB">')}
        ${field('Storage', '<input name="storage" placeholder="128GB">')}${field('Color', '<input name="color">', 'full')}
      </div>
      <div class="full form-grid hidden" id="acc-fields">
        ${field('Accessory type', '<input name="accessory_type" placeholder="Charger, Case...">')}${field('Compatible with', '<input name="compatible_with">')}
      </div>
      <div class="full row"><button class="btn green" id="padd" type="button">Add</button><button class="btn" id="pupd" type="button">Update</button>
        <button class="btn red" id="pdel" type="button" ${user.permissions.delete ? '' : 'disabled'}>Delete</button><button class="btn light" id="pclr" type="button">Clear</button></div>
    </form></div>` : ''}
  </div>`;

  const form = $('#pform');
  const drawTable = () => {
    $('#ptable').innerHTML = table([
      { h: 'SKU', v: (p) => esc(p.sku) }, { h: 'Name', v: (p) => esc(p.name) }, { h: 'Type', v: (p) => (p.type === 'PHONE' ? 'Phone' : 'Accessory') },
      { h: 'Details', v: (p) => esc(p.description) }, { h: 'Buy', v: (p) => num0(p.purchase_price), num: true }, { h: 'Sell', v: (p) => num0(p.sale_price), num: true },
      { h: 'Stock', v: (p) => p.quantity, num: true }, { h: 'Status', v: (p) => `<span class="badge ${p.lowStock ? 'low' : 'ok'}">${p.lowStock ? 'LOW' : 'OK'}</span>` },
    ], list, { rowClass: (p) => (p.lowStock ? 'low clickable' : 'clickable') + (selected && selected.id === p.id ? ' sel' : ''), empty: 'No products found.' });
    if (canEdit) $$('#ptable tbody tr').forEach((tr) => tr.addEventListener('click', () => { selected = list[+tr.dataset.i]; fill(selected); drawTable(); }));
  };
  const load = async () => { list = (await api('GET', '/products?q=' + encodeURIComponent(q))).products; drawTable(); };
  const toggle = () => { const ph = form.type.value === 'PHONE'; $('#phone-fields').classList.toggle('hidden', !ph); $('#acc-fields').classList.toggle('hidden', ph); };
  const fill = (p) => { for (const el of form.elements) if (el.name) el.value = p[el.name] ?? ''; $('#ptitle').textContent = 'Edit: ' + p.name; toggle(); };
  const clear = () => { form.reset(); selected = null; $('#ptitle').textContent = 'New product'; toggle(); drawTable(); };
  const data = () => Object.fromEntries(new FormData(form).entries());

  $('#psearch').addEventListener('click', () => { q = $('#pq').value; load().catch(fail); });
  $('#pq').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#psearch').click(); });
  $('#pall').addEventListener('click', () => { q = ''; $('#pq').value = ''; load().catch(fail); });
  if (canEdit) {
    form.type.addEventListener('change', toggle);
    $('#padd').addEventListener('click', async () => { if (!form.reportValidity()) return; try { await api('POST', '/products', data()); toast('Product added'); clear(); await load(); } catch (e) { fail(e); } });
    $('#pupd').addEventListener('click', async () => {
      if (!selected) return toast('Select a product in the table first.', 'error');
      if (!form.reportValidity()) return;
      try { await api('PUT', '/products/' + selected.id, data()); toast('Product updated'); clear(); await load(); } catch (e) { fail(e); }
    });
    $('#pdel').addEventListener('click', async () => {
      if (!selected) return toast('Select a product in the table first.', 'error');
      if (!(await confirmBox(`Delete "${selected.name}"? Past sales records are kept.`))) return;
      try { await api('DELETE', '/products/' + selected.id); toast('Product deleted'); clear(); await load(); } catch (e) { fail(e); }
    });
    $('#pclr').addEventListener('click', clear);
    toggle();
  }
  await load();
}

// ================================================================ inventory
async function inventoryView(main) {
  main.innerHTML = head('Inventory', 'Live stock levels - rows in red need restocking') + `
  <div class="row" style="margin-bottom:12px"><select id="icat"><option value="">All categories</option></select>
    <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="ilow"> Show low-stock only</label><span class="muted" id="isum" style="margin-left:auto"></span></div>
  <div id="itable"></div>`;
  const load = async () => {
    const r = await api('GET', `/products?low=${$('#ilow').checked ? 1 : 0}&category=${encodeURIComponent($('#icat').value)}`);
    if ($('#icat').options.length === 1) r.categories.forEach((c) => $('#icat').insertAdjacentHTML('beforeend', `<option>${esc(c)}</option>`));
    $('#isum').textContent = `${num0(r.summary.units)} units in stock  |  value ${money(r.summary.value)}`;
    $('#itable').innerHTML = table([
      { h: 'SKU', v: (p) => esc(p.sku) }, { h: 'Product', v: (p) => esc(p.name) }, { h: 'Category', v: (p) => esc(p.category) },
      { h: 'In stock', v: (p) => p.quantity, num: true }, { h: 'Min level', v: (p) => p.min_stock, num: true },
      { h: 'Purchased', v: (p) => p.total_purchased, num: true }, { h: 'Sold', v: (p) => p.total_sold, num: true },
      { h: 'Stock value', v: (p) => money(p.stockValue), num: true },
      { h: 'Status', v: (p) => `<span class="badge ${p.lowStock ? 'low' : 'ok'}">${p.lowStock ? 'LOW STOCK' : 'OK'}</span>` },
    ], r.products, { rowClass: (p) => (p.lowStock ? 'low' : ''), empty: 'No products match.' });
  };
  $('#icat').addEventListener('change', () => load().catch(fail)); $('#ilow').addEventListener('change', () => load().catch(fail));
  await load();
}

// ================================================================ purchases
async function purchasesView(main) {
  const [suppliers, prod] = await Promise.all([api('GET', '/suppliers'), api('GET', '/products')]);
  const products = prod.products; let lines = [], tab = 'new', supplierId = '';
  const draw = async () => {
    main.innerHTML = head('Purchases', 'Buy stock from a supplier - quantities update automatically') + `
    <div class="tabs"><button data-t="new" class="${tab === 'new' ? 'active' : ''}">New Purchase</button><button data-t="hist" class="${tab === 'hist' ? 'active' : ''}">Purchase History</button></div><div id="pbody"></div>`;
    $$('.tabs button').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.t; draw().catch(fail); }));
    tab === 'new' ? drawNew() : await drawHist();
  };
  const drawNew = () => {
    const total = lines.reduce((s, l) => s + l.quantity * l.unitCost, 0);
    $('#pbody').innerHTML = `<div class="card" style="margin-bottom:14px"><div class="row">
        ${field('Supplier', `<select id="psup"><option value="">Select supplier</option>${suppliers.map((s) => `<option value="${s.id}" ${String(s.id) === String(supplierId) ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`, 'grow')}
        ${field('Product', `<select id="pprod"><option value="">Select product</option>${products.map((p) => `<option value="${p.id}" data-cost="${p.purchase_price}">${esc(p.sku)} - ${esc(p.name)} (${p.quantity} in stock)</option>`).join('')}</select>`, 'grow')}
        ${field('Qty', '<input id="pqty" type="number" min="1" step="1" style="width:80px">')}${field('Unit cost', '<input id="pcost" type="number" min="0" step="0.01" style="width:120px">')}
        <button class="btn" id="padd">Add line</button></div></div>
      ${table([{ h: 'Product', v: (l) => esc(l.name) }, { h: 'Qty', v: (l) => l.quantity, num: true }, { h: 'Unit cost', v: (l) => money(l.unitCost), num: true },
        { h: 'Line total', v: (l) => money(l.quantity * l.unitCost), num: true }, { h: '', v: (l) => `<button class="btn light" data-rm="${l.productId}">Remove</button>` }], lines, { empty: 'No lines yet.' })}
      <div class="row" style="margin-top:12px;justify-content:flex-end;align-items:center"><span class="muted">TOTAL</span><b style="font-size:22px">${money(total)}</b><button class="btn green" id="psave">Save Purchase &amp; Update Stock</button></div>`;
    $('#psup').addEventListener('change', (e) => { supplierId = e.target.value; });
    $('#pprod').addEventListener('change', (e) => { const o = e.target.selectedOptions[0]; if (o && o.dataset.cost) $('#pcost').value = o.dataset.cost; });
    $('#padd').addEventListener('click', () => {
      const pid = +$('#pprod').value, qty = +$('#pqty').value, cost = $('#pcost').value;
      if (!pid) return toast('Select a product.', 'error');
      if (!Number.isInteger(qty) || qty < 1) return toast('Quantity must be at least 1.', 'error');
      if (cost === '' || +cost < 0) return toast('Enter a valid unit cost.', 'error');
      const p = products.find((x) => x.id === pid); lines.push({ productId: pid, name: p.name, quantity: qty, unitCost: +cost }); drawNew();
    });
    $$('[data-rm]').forEach((b) => b.addEventListener('click', () => { lines = lines.filter((l) => l.productId !== +b.dataset.rm); drawNew(); }));
    $('#psave').addEventListener('click', async () => {
      try {
        const r = await api('POST', '/purchases', { supplierId, items: lines });
        toast(`${r.number} saved. Stock updated.`); lines = []; supplierId = ''; await refreshProducts(); drawNew();
      } catch (e) { fail(e); }
    });
  };
  const refreshProducts = async () => { products.splice(0, products.length, ...(await api('GET', '/products')).products); };
  const drawHist = async () => {
    const hist = await api('GET', '/purchases');
    $('#pbody').innerHTML = `<p class="muted" style="margin-bottom:8px">Click a row to see its items</p>` + table([
      { h: 'Purchase', v: (p) => p.number }, { h: 'Date', v: (p) => esc(p.date) }, { h: 'Supplier', v: (p) => esc(p.supplier) },
      { h: 'Entered by', v: (p) => esc(p.createdBy) }, { h: 'Total', v: (p) => money(p.total), num: true }], hist, { rowClass: () => 'clickable', empty: 'No purchases recorded yet.' });
    $$('#pbody tbody tr').forEach((tr) => tr.addEventListener('click', async () => {
      const p = await api('GET', '/purchases/' + hist[+tr.dataset.i].id).catch(fail); if (!p) return;
      modal(`${p.number} - ${p.supplier}`, table([{ h: 'Product', v: (i) => esc(i.productName) }, { h: 'Qty', v: (i) => i.quantity, num: true },
        { h: 'Unit cost', v: (i) => money(i.unitCost), num: true }, { h: 'Total', v: (i) => money(i.lineTotal), num: true }], p.items) + `<p style="margin-top:10px"><b>TOTAL: ${money(p.total)}</b></p>`);
    }));
  };
  await draw();
}

// ================================================================ sales & invoices
function showInvoice(inv) {
  modal(`Invoice ${inv.number}`, `<div id="print-area"><pre class="invoice">${esc(inv.invoiceText)}</pre></div>`,
    [{ text: 'Print', cls: '', value: 'print' }, { text: 'Save as text', value: 'save' }, { text: 'Close', value: false }]).then((v) => {
    if (v === 'print') { document.body.insertAdjacentHTML('beforeend', `<div id="print-area"><pre class="invoice">${esc(inv.invoiceText)}</pre></div>`); window.print(); $$('#print-area').forEach((e) => e.remove()); }
    if (v === 'save') { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([inv.invoiceText], { type: 'text/plain' })); a.download = inv.number + '.txt'; a.click(); URL.revokeObjectURL(a.href); }
  });
}
async function salesView(main) {
  let tab = 'new', cart = [], inStock = [], customers = [];
  const load = async () => { [inStock, customers] = await Promise.all([api('GET', '/products?inStock=1').then((r) => r.products), api('GET', '/customers')]); };
  const draw = async () => {
    main.innerHTML = head('Sales', 'Create a sale, then generate the invoice') + `
    <div class="tabs"><button data-t="new" class="${tab === 'new' ? 'active' : ''}">New Sale</button><button data-t="hist" class="${tab === 'hist' ? 'active' : ''}">Sales History</button></div><div id="sbody"></div>`;
    $$('.tabs button').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.t; draw().catch(fail); }));
    tab === 'new' ? drawNew() : await drawHist();
  };
  const drawNew = () => {
    const sub = cart.reduce((s, l) => s + l.quantity * l.price, 0);
    $('#sbody').innerHTML = `<div class="card" style="margin-bottom:14px"><div class="row">
        ${field('Customer', `<select id="scust"><option value="">Walk-in customer</option>${customers.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>`, 'grow')}
        ${field('Product', `<select id="sprod"><option value="">Select product</option>${inStock.map((p) => `<option value="${p.id}">${esc(p.sku)} - ${esc(p.name)} (${p.quantity} left) - ${money(p.sale_price)}</option>`).join('')}</select>`, 'grow')}
        ${field('Qty', '<input id="sqty" type="number" min="1" step="1" value="1" style="width:80px">')}<button class="btn" id="sadd">Add to cart</button></div></div>
      <div class="grid-side"><div>${table([{ h: 'Product', v: (l) => esc(l.name) }, { h: 'Qty', v: (l) => l.quantity, num: true }, { h: 'Unit price', v: (l) => money(l.price), num: true },
        { h: 'Line total', v: (l) => money(l.quantity * l.price), num: true }, { h: '', v: (l) => `<button class="btn light" data-rm="${l.productId}">Remove</button>` }], cart, { empty: 'Cart is empty - add products above.' })}</div>
      <div class="card"><h3>Payment</h3><div class="stack">
        ${field('Payment method', '<select id="spay"><option>Cash</option><option>Card</option><option>Bank Transfer</option><option>Easypaisa / JazzCash</option></select>')}
        ${field('Discount (Rs)', '<input id="sdisc" type="number" min="0" step="0.01" value="0">')}
        <div class="totals"><span class="muted">Subtotal</span><b>${money(sub)}</b></div>
        <div class="totals big"><span>TOTAL</span><b id="stotal">${money(sub)}</b></div>
        <button class="btn green block" id="sdone">Complete Sale &amp; Invoice</button></div></div></div>`;
    $('#sdisc').addEventListener('input', () => { $('#stotal').textContent = money(Math.max(0, sub - (+$('#sdisc').value || 0))); });
    $('#sadd').addEventListener('click', () => {
      const pid = +$('#sprod').value, qty = +$('#sqty').value; if (!pid) return toast('Select a product.', 'error');
      if (!Number.isInteger(qty) || qty < 1) return toast('Quantity must be at least 1.', 'error');
      const p = inStock.find((x) => x.id === pid), have = (cart.find((l) => l.productId === pid) || { quantity: 0 }).quantity;
      if (have + qty > p.quantity) return toast(`Only ${p.quantity} in stock for ${p.name}.`, 'error');
      const ex = cart.find((l) => l.productId === pid); if (ex) ex.quantity += qty; else cart.push({ productId: pid, name: p.name, quantity: qty, price: p.sale_price });
      const keep = { c: $('#scust').value }; drawNew(); $('#scust').value = keep.c;
    });
    $$('[data-rm]').forEach((b) => b.addEventListener('click', () => { const keep = $('#scust').value; cart = cart.filter((l) => l.productId !== +b.dataset.rm); drawNew(); $('#scust').value = keep; }));
    $('#sdone').addEventListener('click', async () => {
      try {
        const inv = await api('POST', '/sales', { customerId: $('#scust').value || null, discount: $('#sdisc').value, paymentMethod: $('#spay').value, items: cart.map((l) => ({ productId: l.productId, quantity: l.quantity })) });
        cart = []; await load(); drawNew(); showInvoice(inv);
      } catch (e) { fail(e); await load().catch(() => {}); drawNew(); }
    });
  };
  const drawHist = async () => {
    const hist = await api('GET', '/sales');
    $('#sbody').innerHTML = `<p class="muted" style="margin-bottom:8px">Click a row to reopen its invoice</p>` + table([
      { h: 'Invoice', v: (s) => s.number }, { h: 'Date', v: (s) => esc(s.date) }, { h: 'Customer', v: (s) => esc(s.customer) }, { h: 'Payment', v: (s) => esc(s.payment) },
      { h: 'Discount', v: (s) => money(s.discount), num: true }, { h: 'Total', v: (s) => money(s.total), num: true }, { h: 'Cashier', v: (s) => esc(s.createdBy) }],
    hist, { rowClass: () => 'clickable', empty: 'No sales recorded yet.' });
    $$('#sbody tbody tr').forEach((tr) => tr.addEventListener('click', async () => { try { showInvoice(await api('GET', '/sales/' + hist[+tr.dataset.i].id)); } catch (e) { fail(e); } }));
  };
  await load(); await draw();
}

// ================================================================ customers / suppliers
async function partyView(base, kind) {
  const main = $('#main'); let list = [], selected = null, q = '';
  main.innerHTML = head(kind + 's', 'Contact details and transaction history') + `<div class="grid-side">
    <div class="stack"><div class="row"><input id="qq" class="grow" placeholder="Search by name, phone or email..."><button class="btn" id="qs">Search</button><button class="btn light" id="qa">Show all</button></div><div id="qt"></div></div>
    <div class="card"><h3 id="qh">New ${kind.toLowerCase()}</h3><form id="qf" class="stack">
      ${field('Name *', '<input name="name" required>')}${field('Phone', '<input name="phone">')}${field('Email', '<input name="email" type="email">')}${field('Address', '<input name="address">')}
      <div class="row"><button type="button" class="btn green" id="qadd">Add</button><button type="button" class="btn" id="qupd">Update</button>
        <button type="button" class="btn red" id="qdel" ${user.permissions.delete ? '' : 'disabled'}>Delete</button></div>
      <div class="row"><button type="button" class="btn light" id="qhist">History</button><button type="button" class="btn light" id="qclr">Clear</button></div></form></div></div>`;
  const form = $('#qf');
  const drawT = () => {
    $('#qt').innerHTML = table([{ h: 'Name', v: (p) => esc(p.name) }, { h: 'Phone', v: (p) => esc(p.phone) }, { h: 'Email', v: (p) => esc(p.email) }, { h: 'Address', v: (p) => esc(p.address) }],
      list, { rowClass: (p) => 'clickable' + (selected && selected.id === p.id ? ' sel' : ''), empty: `No ${kind.toLowerCase()}s found.` });
    $$('#qt tbody tr').forEach((tr) => tr.addEventListener('click', () => { selected = list[+tr.dataset.i]; for (const el of form.elements) if (el.name) el.value = selected[el.name] ?? ''; $('#qh').textContent = 'Edit: ' + selected.name; drawT(); }));
  };
  const load = async () => { list = await api('GET', `/${base}?q=${encodeURIComponent(q)}`); drawT(); };
  const clear = () => { form.reset(); selected = null; $('#qh').textContent = `New ${kind.toLowerCase()}`; drawT(); };
  const data = () => Object.fromEntries(new FormData(form).entries());
  $('#qs').addEventListener('click', () => { q = $('#qq').value; load().catch(fail); });
  $('#qq').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#qs').click(); });
  $('#qa').addEventListener('click', () => { q = ''; $('#qq').value = ''; load().catch(fail); });
  $('#qadd').addEventListener('click', async () => { if (!form.reportValidity()) return; try { await api('POST', `/${base}`, data()); toast(kind + ' added'); clear(); await load(); } catch (e) { fail(e); } });
  $('#qupd').addEventListener('click', async () => { if (!selected) return toast(`Select a ${kind.toLowerCase()} first.`, 'error'); if (!form.reportValidity()) return;
    try { await api('PUT', `/${base}/${selected.id}`, data()); toast(kind + ' updated'); clear(); await load(); } catch (e) { fail(e); } });
  $('#qdel').addEventListener('click', async () => { if (!selected) return toast(`Select a ${kind.toLowerCase()} first.`, 'error');
    if (!(await confirmBox(`Delete ${selected.name}?`))) return; try { await api('DELETE', `/${base}/${selected.id}`); toast('Deleted'); clear(); await load(); } catch (e) { fail(e); } });
  $('#qhist').addEventListener('click', async () => { if (!selected) return toast(`Select a ${kind.toLowerCase()} first.`, 'error');
    try { const h = await api('GET', `/${base}/${selected.id}/history`);
      modal(selected.name + ' - transactions', table([{ h: 'Ref', v: (r) => r.ref }, { h: 'Date', v: (r) => esc(r.date) }, { h: 'Total', v: (r) => money(r.total), num: true }, { h: 'Note', v: (r) => esc(r.note) }], h, { empty: 'No transactions yet.' })); } catch (e) { fail(e); } });
  $('#qclr').addEventListener('click', clear);
  await load();
}

// ================================================================ reports
async function reportsView(main) {
  const TYPES = [['daily', 'Daily sales'], ['monthly', 'Monthly sales'], ['purchases', 'Monthly purchases'], ['inventory', 'Inventory'], ['lowstock', 'Low stock'], ['product', 'Product-wise sales']];
  let current = null;
  main.innerHTML = head('Reports', 'Sales, purchases, inventory and product performance') + `<div class="card" style="margin-bottom:14px"><div class="row">
    ${field('Report', `<select id="rtype">${TYPES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>`)}
    ${field('Date / month', `<input id="rdate" type="date" value="${today()}">`)}<button class="btn" id="rgo">Generate</button><button class="btn light" id="rcsv">Export CSV</button></div></div>
    <h3 id="rtitle" style="margin-bottom:8px"></h3><div id="rtable"></div>`;
  const gen = async () => {
    current = await api('GET', `/reports/${$('#rtype').value}?date=${$('#rdate').value || today()}`);
    $('#rtitle').textContent = `${current.title}   (${current.rows.length} rows)`;
    $('#rtable').innerHTML = table(current.columns.map((c, i) => ({ h: c, v: (r) => esc(r[i]), num: /Rs|Qty|Units|Stock|Sold|Items|Invoices|Purchased|Minimum|Shortfall/.test(c) })), current.rows, { empty: 'No data for this selection.' });
  };
  $('#rgo').addEventListener('click', () => gen().catch(fail));
  $('#rcsv').addEventListener('click', () => {
    if (!current) return toast('Generate a report first.', 'error');
    const q = (c) => '"' + String(c ?? '').replace(/"/g, '""') + '"';
    const csv = [current.columns, ...current.rows].map((r) => r.map(q).join(',')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    a.download = current.title.replace(/[^A-Za-z0-9_-]+/g, '_') + '.csv'; a.click(); URL.revokeObjectURL(a.href);
  });
  await gen();
}

// ================================================================ users
async function usersView(main) {
  let list = [];
  main.innerHTML = head('Users', 'Admins have full access; sales staff can sell and view stock') + `<div class="grid-side"><div id="ut"></div>
    <div class="card"><h3>New account</h3><form id="uf" class="stack">${field('Full name', '<input name="fullName" required>')}${field('Username', '<input name="username" required>')}
      ${field('Password (min 4)', '<input name="password" type="password" required minlength="4">')}${field('Role', '<select name="role"><option value="STAFF">Sales Staff</option><option value="ADMIN">Admin</option></select>')}
      <button class="btn green">Create account</button></form></div></div>`;
  const load = async () => {
    list = await api('GET', '/users');
    $('#ut').innerHTML = table([{ h: 'Full name', v: (u) => esc(u.fullName) }, { h: 'Username', v: (u) => esc(u.username) }, { h: 'Role', v: (u) => (u.role === 'ADMIN' ? 'Admin' : 'Sales Staff') },
      { h: '', v: (u) => (u.id === user.id ? '<span class="muted">you</span>' : `<button class="btn red" data-del="${u.id}">Delete</button>`) }], list);
    $$('[data-del]').forEach((b) => b.addEventListener('click', async () => { const u = list.find((x) => x.id === +b.dataset.del);
      if (!(await confirmBox(`Delete account ${u.username}?`))) return; try { await api('DELETE', '/users/' + u.id); toast('Account deleted'); await load(); } catch (e) { fail(e); } }));
  };
  $('#uf').addEventListener('submit', async (e) => { e.preventDefault();
    try { await api('POST', '/users', Object.fromEntries(new FormData(e.target).entries())); toast('Account created'); e.target.reset(); await load(); } catch (err) { fail(err); } });
  await load();
}

// ================================================================ boot
(async function boot() {
  if (store.token) { try { user = await api('GET', '/me'); showShell(); return; } catch { /* fall through to login */ } }
  showLogin();
})();
