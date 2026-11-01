'use strict';
// Run with: npm test   (uses an in-memory database, your real data is untouched)
process.env.DB_FILE = ':memory:';
const test = require('node:test');
const assert = require('node:assert');
const app = require('../server');

let server, base;
test.before(async () => { await new Promise((r) => { server = app.listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());

async function call(method, url, body, token) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
}
let admin, staff;

test('login works and rejects wrong password', async () => {
  assert.strictEqual((await call('POST', '/api/login', { username: 'admin', password: 'bad' })).status, 401);
  const a = await call('POST', '/api/login', { username: 'admin', password: 'admin123' });
  const s = await call('POST', '/api/login', { username: 'staff', password: 'staff123' });
  assert.strictEqual(a.status, 200); assert.strictEqual(a.data.user.role, 'ADMIN'); assert.strictEqual(s.data.user.permissions.reports, false);
  admin = a.data.token; staff = s.data.token;
});
test('API requires login', async () => assert.strictEqual((await call('GET', '/api/products')).status, 401));
test('staff is blocked from admin features (polymorphic permissions)', async () => {
  for (const [m, u, b] of [['GET', '/api/reports/inventory'], ['GET', '/api/purchases'], ['GET', '/api/suppliers'], ['GET', '/api/users'],
    ['POST', '/api/products', { sku: 'x', name: 'x', purchase_price: 1, sale_price: 2 }], ['DELETE', '/api/products/1']])
    assert.strictEqual((await call(m, u, b, staff)).status, 403, u);
  assert.strictEqual((await call('GET', '/api/customers', null, staff)).status, 200);
});
test('product CRUD + validation + duplicate SKU', async () => {
  const bad = await call('POST', '/api/products', { sku: 'T-1', name: 'Test', purchase_price: -5, sale_price: 10 }, admin);
  assert.strictEqual(bad.status, 400);
  const ok = await call('POST', '/api/products', { type: 'PHONE', sku: 'T-1', name: 'Test Phone', purchase_price: 100, sale_price: 150, quantity: 5, min_stock: 2, brand: 'X' }, admin);
  assert.strictEqual(ok.status, 200);
  assert.strictEqual((await call('POST', '/api/products', { sku: 'T-1', name: 'Dup', purchase_price: 1, sale_price: 2 }, admin)).status, 400);
  const up = await call('PUT', '/api/products/' + ok.data.id, { type: 'PHONE', sku: 'T-1', name: 'Test Phone 2', purchase_price: 100, sale_price: 160, quantity: 5, min_stock: 2 }, admin);
  assert.strictEqual(up.status, 200);
  const list = await call('GET', '/api/products?q=Test', null, admin);
  assert.strictEqual(list.data.products[0].name, 'Test Phone 2'); assert.strictEqual(list.data.products[0].sale_price, 160);
});
test('sale reduces stock, uses DB prices, produces invoice', async () => {
  const before = (await call('GET', '/api/products?q=Charger', null, staff)).data.products[0];
  const r = await call('POST', '/api/sales', { customerId: 1, discount: 100, paymentMethod: 'Card',
    items: [{ productId: before.id, quantity: 2, price: 1 }] }, staff);   // client "price" must be ignored
  assert.strictEqual(r.status, 200); assert.strictEqual(r.data.subtotal, 3000); assert.strictEqual(r.data.total, 2900);
  assert.match(r.data.invoiceText, /INV-0000\d/); assert.match(r.data.invoiceText, /Ali Raza/);
  const after = (await call('GET', '/api/products?q=Charger', null, staff)).data.products[0];
  assert.strictEqual(after.quantity, before.quantity - 2);
  assert.strictEqual((await call('GET', '/api/sales/' + r.data.id, null, staff)).data.items.length, 1);
});
test('overselling is rejected and nothing changes (transaction rollback)', async () => {
  const phone = (await call('GET', '/api/products?q=iPhone', null, admin)).data.products[0];
  const charger = (await call('GET', '/api/products?q=Charger', null, admin)).data.products[0];
  const r = await call('POST', '/api/sales', { items: [{ productId: charger.id, quantity: 1 }, { productId: phone.id, quantity: 999 }] }, admin);
  assert.strictEqual(r.status, 400); assert.match(r.data.error, /Not enough stock/);
  assert.strictEqual((await call('GET', '/api/products?q=Charger', null, admin)).data.products[0].quantity, charger.quantity);
  assert.strictEqual((await call('POST', '/api/sales', { items: [] }, admin)).status, 400);
  assert.strictEqual((await call('POST', '/api/sales', { discount: 999999, items: [{ productId: charger.id, quantity: 1 }] }, admin)).status, 400);
});
test('purchase increases stock and updates cost', async () => {
  const p = (await call('GET', '/api/products?q=Earbuds', null, admin)).data.products[0];
  const r = await call('POST', '/api/purchases', { supplierId: 1, items: [{ productId: p.id, quantity: 10, unitCost: 2600 }] }, admin);
  assert.strictEqual(r.status, 200); assert.strictEqual(r.data.total, 26000);
  const n = (await call('GET', '/api/products?q=Earbuds', null, admin)).data.products[0];
  assert.strictEqual(n.quantity, p.quantity + 10); assert.strictEqual(n.purchase_price, 2600);
});
test('dashboard and every report work', async () => {
  const d = (await call('GET', '/api/dashboard', null, admin)).data;
  assert.ok(d.salesToday >= 2900); assert.strictEqual(d.last7.length, 7); assert.ok(d.lowStockCount >= 1);
  for (const t of ['daily', 'monthly', 'purchases', 'inventory', 'lowstock', 'product']) {
    const r = await call('GET', '/api/reports/' + t, null, admin);
    assert.strictEqual(r.status, 200, t); assert.ok(Array.isArray(r.data.rows), t);
  }
  const prod = (await call('GET', '/api/reports/product', null, admin)).data;
  assert.ok(prod.rows.length >= 1);
});
test('customers/suppliers history, users management', async () => {
  assert.ok((await call('GET', '/api/customers/1/history', null, admin)).data.length >= 1);
  assert.ok((await call('GET', '/api/suppliers/1/history', null, admin)).data.length >= 1);
  assert.strictEqual((await call('POST', '/api/users', { fullName: 'N', username: 'admin', password: '1234' }, admin)).status, 400);
  assert.strictEqual((await call('POST', '/api/users', { fullName: 'N', username: 'newbie', password: '1234', role: 'STAFF' }, admin)).status, 200);
  assert.strictEqual((await call('DELETE', '/api/users/1', null, admin)).status, 400);  // cannot delete self
});
test('logout invalidates token', async () => {
  await call('POST', '/api/logout', {}, staff);
  assert.strictEqual((await call('GET', '/api/me', null, staff)).status, 401);
});
