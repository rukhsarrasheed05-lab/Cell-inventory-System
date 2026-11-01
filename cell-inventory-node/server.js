'use strict';
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const S = require('./src/services');

const app = express();
app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------------- sessions (in memory)
const sessions = new Map(); // token -> { userId, expires }
const TTL = 8 * 3600 * 1000;

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const s = sessions.get(token);
  if (!s || s.expires < Date.now()) { sessions.delete(token); return res.status(401).json({ error: 'Please log in.' }); }
  const user = S.Users.byId(s.userId);
  if (!user) return res.status(401).json({ error: 'Account no longer exists.' });
  s.expires = Date.now() + TTL;
  req.user = user; req.token = token;
  next();
}
/** Role check using the User class' polymorphic permission methods. */
const need = (perm) => (req, res, next) =>
  req.user[perm]() ? next() : res.status(403).json({ error: 'You do not have permission to do that.' });
const h = (fn) => (req, res, next) => { try { res.json(fn(req, res) ?? { ok: true }); } catch (e) { next(e); } };

// ---------------------------------------------------------------- auth
const attempts = new Map();
app.post('/api/login', (req, res) => {
  const key = req.ip;
  const a = attempts.get(key) || { n: 0, until: 0 };
  if (a.until > Date.now()) return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
  const user = S.Users.authenticate(req.body.username, req.body.password);
  if (!user) {
    a.n += 1; if (a.n >= 8) { a.n = 0; a.until = Date.now() + 60000; }
    attempts.set(key, a);
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  attempts.delete(key);
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { userId: user.id, expires: Date.now() + TTL });
  res.json({ token, user });
});
app.post('/api/logout', auth, (req, res) => { sessions.delete(req.token); res.json({ ok: true }); });
app.get('/api/me', auth, (req, res) => res.json(req.user));

// ---------------------------------------------------------------- dashboard & reports
app.get('/api/dashboard', auth, h(() => S.Reports.dashboard()));
app.get('/api/reports/:type', auth, need('canViewReports'), h((req) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : new Date().toLocaleDateString('en-CA');
  return S.Reports.build(req.params.type, date, date.slice(0, 7));
}));

// ---------------------------------------------------------------- products
app.get('/api/products', auth, h((req) => ({
  products: S.Products.list({ q: req.query.q, lowOnly: req.query.low === '1', category: req.query.category, inStock: req.query.inStock === '1' }),
  categories: S.Products.categories(), summary: S.Products.summary(),
})));
app.post('/api/products', auth, need('canManageProducts'), h((req) => ({ id: S.Products.create(req.body) })));
app.put('/api/products/:id', auth, need('canManageProducts'), h((req) => S.Products.update(Number(req.params.id), req.body)));
app.delete('/api/products/:id', auth, need('canDelete'), h((req) => S.Products.remove(Number(req.params.id))));

// ---------------------------------------------------------------- customers & suppliers
function partyRoutes(base, svc, perm) {
  app.get(`/api/${base}`, auth, need(perm), h((req) => svc.list(req.query.q)));
  app.post(`/api/${base}`, auth, need(perm), h((req) => svc.save(null, req.body)));
  app.put(`/api/${base}/:id`, auth, need(perm), h((req) => svc.save(Number(req.params.id), req.body)));
  app.delete(`/api/${base}/:id`, auth, need(perm), need('canDelete'), h((req) => svc.remove(Number(req.params.id))));
  app.get(`/api/${base}/:id/history`, auth, need(perm), h((req) => svc.history(Number(req.params.id))));
}
// Sales staff may use customers; suppliers/purchases are admin only.
partyRoutes('customers', S.Customers, 'canManageCustomers');
partyRoutes('suppliers', S.Suppliers, 'canManagePurchases');

// ---------------------------------------------------------------- sales & purchases
app.get('/api/sales', auth, h(() => S.Sales.list()));
app.get('/api/sales/:id', auth, h((req) => S.Sales.get(Number(req.params.id))));
app.post('/api/sales', auth, h((req) => S.Sales.create(req.body, req.user)));
app.get('/api/purchases', auth, need('canManagePurchases'), h(() => S.Purchases.list()));
app.get('/api/purchases/:id', auth, need('canManagePurchases'), h((req) => S.Purchases.get(Number(req.params.id))));
app.post('/api/purchases', auth, need('canManagePurchases'), h((req) => S.Purchases.create(req.body, req.user)));

// ---------------------------------------------------------------- users (admin)
app.get('/api/users', auth, need('canManageUsers'), h(() => S.Users.all()));
app.post('/api/users', auth, need('canManageUsers'), h((req) => S.Users.create(req.body)));
app.delete('/api/users/:id', auth, need('canManageUsers'), h((req) => S.Users.remove(Number(req.params.id), req.user.id)));

// ---------------------------------------------------------------- static + errors
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof S.HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`\n  Cell Inventory & Sales System running ->  http://localhost:${PORT}\n`));
}
module.exports = app;
