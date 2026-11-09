'use strict';

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const S = require('./src/pg-services');

const app = express();

app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

// --------------------------------------------------
// PERSISTENT SESSIONS - NEON POSTGRESQL
// --------------------------------------------------

const TTL = 8 * 60 * 60 * 1000;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function auth(req, res, next) {
  (async () => {
    const token = (req.headers.authorization || '')
      .replace(/^Bearer\s+/i, '');

    if (!token) {
      return res.status(401).json({ error: 'Please log in.' });
    }

    const tokenHash = hashToken(token);

    const result = await S.pool.query(
      `SELECT user_id, expires_at
       FROM sessions
       WHERE token_hash = $1`,
      [tokenHash]
    );

    const session = result.rows[0];

    if (!session || new Date(session.expires_at) < new Date()) {
      await S.pool.query(
        'DELETE FROM sessions WHERE token_hash = $1',
        [tokenHash]
      );

      return res.status(401).json({ error: 'Please log in.' });
    }

    const user = await S.Users.byId(session.user_id);

    if (!user) {
      await S.pool.query(
        'DELETE FROM sessions WHERE token_hash = $1',
        [tokenHash]
      );

      return res.status(401).json({
        error: 'Account no longer exists.'
      });
    }

    const expiresAt = new Date(Date.now() + TTL);

    await S.pool.query(
      'UPDATE sessions SET expires_at = $2 WHERE token_hash = $1',
      [tokenHash, expiresAt]
    );

    req.user = user;
    req.token = token;

    next();
  })().catch(next);
}

// --------------------------------------------------
// ROLE PERMISSIONS
// --------------------------------------------------

const need = (perm) => (req, res, next) => {
  try {
    if (req.user[perm]()) return next();

    return res.status(403).json({
      error: 'You do not have permission to do that.'
    });
  } catch (error) {
    next(error);
  }
};

// --------------------------------------------------
// ASYNC RESPONSE HANDLER
// --------------------------------------------------

const h = (fn) => (req, res, next) => {
  Promise.resolve()
    .then(() => fn(req, res))
    .then((data) => res.json(data ?? { ok: true }))
    .catch(next);
};

// --------------------------------------------------
// LOGIN
// --------------------------------------------------

const attempts = new Map();

app.post('/api/login', async (req, res, next) => {
  try {
    const key = req.ip;

    const a = attempts.get(key) || {
      n: 0,
      until: 0
    };

    if (a.until > Date.now()) {
      return res.status(429).json({
        error: 'Too many attempts. Try again in a minute.'
      });
    }

    const user = await S.Users.authenticate(
      req.body.username,
      req.body.password
    );

    if (!user) {
      a.n++;

      if (a.n >= 8) {
        a.n = 0;
        a.until = Date.now() + 60000;
      }

      attempts.set(key, a);

      return res.status(401).json({
        error: 'Invalid username or password.'
      });
    }

    attempts.delete(key);

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + TTL);

    await S.pool.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at)
       VALUES ($1, $2, $3)`,
      [tokenHash, user.id, expiresAt]
    );

    res.json({ token, user });

  } catch (error) {
    next(error);
  }
});

// --------------------------------------------------
// LOGOUT AND CURRENT USER
// --------------------------------------------------

app.post('/api/logout', auth, h(async (req) => {
  await S.pool.query(
    'DELETE FROM sessions WHERE token_hash = $1',
    [hashToken(req.token)]
  );

  return { ok: true };
}));

app.get('/api/me', auth, h((req) => req.user));

// --------------------------------------------------
// DASHBOARD AND REPORTS
// --------------------------------------------------

app.get('/api/dashboard', auth,
  h(() => S.Reports.dashboard())
);

app.get('/api/reports/:type', auth,
  need('canViewReports'),
  h((req) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '')
      ? req.query.date
      : new Date().toLocaleDateString('en-CA');

    return S.Reports.build(
      req.params.type,
      date,
      date.slice(0, 7)
    );
  })
);

// --------------------------------------------------
// PRODUCTS
// --------------------------------------------------

app.get('/api/products', auth, h(async (req) => ({
  products: await S.Products.list({
    q: req.query.q,
    lowOnly: req.query.low === '1',
    category: req.query.category,
    inStock: req.query.inStock === '1'
  }),

  categories: await S.Products.categories(),
  summary: await S.Products.summary()
})));

app.post('/api/products', auth,
  need('canManageProducts'),
  h(async (req) => ({
    id: await S.Products.create(req.body)
  }))
);

app.put('/api/products/:id', auth,
  need('canManageProducts'),
  h((req) => S.Products.update(
    Number(req.params.id),
    req.body
  ))
);

app.delete('/api/products/:id', auth,
  need('canDelete'),
  h((req) => S.Products.remove(Number(req.params.id)))
);

// --------------------------------------------------
// CUSTOMERS AND SUPPLIERS
// --------------------------------------------------

function partyRoutes(base, svc, perm) {

  app.get(`/api/${base}`, auth,
    need(perm),
    h((req) => svc.list(req.query.q))
  );

  app.post(`/api/${base}`, auth,
    need(perm),
    h((req) => svc.save(null, req.body))
  );

  app.put(`/api/${base}/:id`, auth,
    need(perm),
    h((req) => svc.save(
      Number(req.params.id),
      req.body
    ))
  );

  app.delete(`/api/${base}/:id`, auth,
    need(perm),
    need('canDelete'),
    h((req) => svc.remove(Number(req.params.id)))
  );

  app.get(`/api/${base}/:id/history`, auth,
    need(perm),
    h((req) => svc.history(Number(req.params.id)))
  );
}

partyRoutes('customers', S.Customers, 'canManageCustomers');
partyRoutes('suppliers', S.Suppliers, 'canManagePurchases');

// --------------------------------------------------
// SALES
// --------------------------------------------------

app.get('/api/sales', auth,
  h(() => S.Sales.list())
);

app.get('/api/sales/:id', auth,
  h((req) => S.Sales.get(Number(req.params.id)))
);

app.post('/api/sales', auth,
  h((req) => S.Sales.create(req.body, req.user))
);

// --------------------------------------------------
// PURCHASES
// --------------------------------------------------

app.get('/api/purchases', auth,
  need('canManagePurchases'),
  h(() => S.Purchases.list())
);

app.get('/api/purchases/:id', auth,
  need('canManagePurchases'),
  h((req) => S.Purchases.get(Number(req.params.id)))
);

app.post('/api/purchases', auth,
  need('canManagePurchases'),
  h((req) => S.Purchases.create(req.body, req.user))
);

// --------------------------------------------------
// USERS - ADMIN ONLY
// --------------------------------------------------

app.get('/api/users', auth,
  need('canManageUsers'),
  h(() => S.Users.all())
);

app.post('/api/users', auth,
  need('canManageUsers'),
  h((req) => S.Users.create(req.body))
);

app.delete('/api/users/:id', auth,
  need('canManageUsers'),
  h((req) => S.Users.remove(
    Number(req.params.id),
    req.user.id
  ))
);

// --------------------------------------------------
// STATIC FRONTEND AND ERROR HANDLING
// --------------------------------------------------

app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

app.use((err, req, res, next) => {
  if (err instanceof S.HttpError) {
    return res.status(err.status).json({
      error: err.message
    });
  }

  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: 'Invalid JSON.'
    });
  }

  console.error(err);

  res.status(500).json({
    error: 'Something went wrong on the server.'
  });
});

// --------------------------------------------------
// LOCAL SERVER
// --------------------------------------------------

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(
      `\nCell Inventory & Sales System running -> http://localhost:${PORT}\n`
    );
  });
}

module.exports = app;