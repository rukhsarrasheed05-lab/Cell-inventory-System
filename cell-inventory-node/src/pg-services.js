'use strict';

// PostgreSQL service layer for Cell Inventory System.

require('dotenv').config();
const { Pool } = require('pg');
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);
const M = require('./models');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

// Use Karachi timezone for database dates.
pool.on('connect', (client) => {
  client.query("SET TIME ZONE 'Asia/Karachi'").catch((err) => {
    console.error('Could not set database timezone:', err.message);
  });
});

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const fail = (status, message) => {
  throw new HttpError(status, message);
};

const int = (v, name = 'Quantity', min = 1) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) {
    fail(400, `${name} must be an integer of at least ${min}`);
  }
  return n;
};

const money = (v, name = 'Amount', min = 0) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) {
    fail(400, `${name} must be a valid amount`);
  }
  return Math.round((n + Number.EPSILON) * 100) / 100;
};

const text = (v) => String(v ?? '').trim();

const required = (v, name) => {
  const s = text(v);
  if (!s) fail(400, `${name} is required`);
  return s;
};

const num = (v) => Number(v || 0);

// Transaction helper
async function transaction(work) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await work(client);

    await client.query('COMMIT');

    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Password hashing
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');

  const key = await scrypt(String(password), salt, 32);

  return `${salt}:${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  if (!stored || !String(stored).includes(':')) {
    return false;
  }

  const [salt, hash] = String(stored).split(':');

  const key = await scrypt(String(password), salt, 32);

  const expected = Buffer.from(hash, 'hex');

  return expected.length === key.length &&
    crypto.timingSafeEqual(expected, key);
}

// --------------------------------------------------
// USERS
// --------------------------------------------------

const Users = {

  async authenticate(username, password) {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE username = $1',
      [text(username)]
    );

    if (!rows[0]) return null;

    const valid = await verifyPassword(
      password,
      rows[0].password_hash
    );

    if (!valid) return null;

    return M.User.from(rows[0]);
  },

  async byId(id) {
    const { rows } = await pool.query(
      'SELECT id, username, full_name, role FROM users WHERE id = $1',
      [id]
    );

    return rows[0] ? M.User.from(rows[0]) : null;
  },

  async all() {
    const { rows } = await pool.query(
      'SELECT id, username, full_name, role FROM users ORDER BY id'
    );

    return rows.map(row => M.User.from(row));
  },

  async create(data) {
    const username = required(data.username, 'Username');

    const fullName = required(
      data.full_name ?? data.fullName,
      'Full name'
    );

    const password = required(data.password, 'Password');

    const role = text(data.role || 'STAFF').toUpperCase();

    if (!['ADMIN', 'STAFF'].includes(role)) {
      fail(400, 'Invalid user role');
    }

    if (password.length < 6) {
      fail(400, 'Password must be at least 6 characters');
    }

    const passwordHash = await hashPassword(password);

    try {
      const { rows } = await pool.query(
        `INSERT INTO users
        (username, password_hash, full_name, role)
        VALUES ($1, $2, $3, $4)
        RETURNING id, username, full_name, role`,
        [username, passwordHash, fullName, role]
      );

      return M.User.from(rows[0]);

    } catch (err) {
      if (err.code === '23505') {
        fail(409, 'Username already exists');
      }

      throw err;
    }
  },

  async remove(id, currentUserId) {
    if (Number(id) === Number(currentUserId)) {
      fail(400, 'You cannot delete your own account');
    }

    const result = await pool.query(
      'DELETE FROM users WHERE id = $1',
      [id]
    );

    if (!result.rowCount) {
      fail(404, 'User not found');
    }

    return { ok: true };
  }
};

// --------------------------------------------------
// PRODUCTS
// --------------------------------------------------

const Products = {

  async list(filters = {}) {
    const values = [];
    const where = [];

    if (filters.search) {
      values.push(`%${text(filters.search)}%`);

      where.push(
        `(name ILIKE $${values.length}
        OR sku ILIKE $${values.length}
        OR brand ILIKE $${values.length}
        OR model ILIKE $${values.length})`
      );
    }

    if (filters.type && filters.type !== 'ALL') {
      values.push(text(filters.type).toUpperCase());

      where.push(`type = $${values.length}`);
    }

    const sql = `
      SELECT *
      FROM products
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY id DESC
    `;

    const { rows } = await pool.query(sql, values);

    return rows.map(row => M.Product.from(row));
  },

  async categories() {
    const { rows } = await pool.query(`
      SELECT DISTINCT category
      FROM products
      WHERE category IS NOT NULL
      AND category <> ''
      ORDER BY category
    `);

    return rows.map(row => row.category);
  },

  async summary() {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)::int AS total_products,
        COALESCE(SUM(quantity), 0)::int AS total_units,
        COUNT(*) FILTER (
          WHERE quantity <= min_stock
        )::int AS low_stock,
        COALESCE(
          SUM(quantity * purchase_price), 0
        )::numeric AS stock_value
      FROM products
    `);

    return rows[0];
  },

  clean(data) {
    const type = text(data.type || 'PHONE').toUpperCase();

    if (!['PHONE', 'ACCESSORY'].includes(type)) {
      fail(400, 'Product type must be PHONE or ACCESSORY');
    }

    return {
      sku: required(data.sku, 'SKU'),
      name: required(data.name, 'Product name'),
      type,

      category: text(data.category),

      purchase_price: money(
        data.purchase_price ?? data.purchasePrice,
        'Purchase price'
      ),

      sale_price: money(
        data.sale_price ?? data.salePrice,
        'Sale price'
      ),

      quantity: int(data.quantity ?? 0, 'Quantity', 0),

      min_stock: int(
        data.min_stock ?? data.minStock ?? 5,
        'Minimum stock',
        0
      ),

      supplier_id:
        data.supplier_id || data.supplierId
          ? int(data.supplier_id ?? data.supplierId, 'Supplier ID')
          : null,

      brand: text(data.brand),
      model: text(data.model),
      ram: text(data.ram),
      storage: text(data.storage),
      color: text(data.color),

      accessory_type: text(
        data.accessory_type ?? data.accessoryType
      ),

      compatible_with: text(
        data.compatible_with ?? data.compatibleWith
      )
    };
  },

  async create(data) {
    const p = this.clean(data);

    try {
      const { rows } = await pool.query(`
        INSERT INTO products (
          sku, name, type, category,
          purchase_price, sale_price,
          quantity, min_stock, supplier_id,
          brand, model, ram, storage, color,
          accessory_type, compatible_with
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,
          $9,$10,$11,$12,$13,$14,$15,$16
        )
        RETURNING *
      `, [
        p.sku,
        p.name,
        p.type,
        p.category,
        p.purchase_price,
        p.sale_price,
        p.quantity,
        p.min_stock,
        p.supplier_id,
        p.brand,
        p.model,
        p.ram,
        p.storage,
        p.color,
        p.accessory_type,
        p.compatible_with
      ]);

      return M.Product.from(rows[0]);

    } catch (err) {
      if (err.code === '23505') {
        fail(409, 'SKU already exists');
      }

      if (err.code === '23503') {
        fail(400, 'Selected supplier does not exist');
      }

      throw err;
    }
  },

  async update(id, data) {
    const p = this.clean(data);

    try {
      const { rows } = await pool.query(`
        UPDATE products SET
          sku=$1,
          name=$2,
          type=$3,
          category=$4,
          purchase_price=$5,
          sale_price=$6,
          quantity=$7,
          min_stock=$8,
          supplier_id=$9,
          brand=$10,
          model=$11,
          ram=$12,
          storage=$13,
          color=$14,
          accessory_type=$15,
          compatible_with=$16
        WHERE id=$17
        RETURNING *
      `, [
        p.sku,
        p.name,
        p.type,
        p.category,
        p.purchase_price,
        p.sale_price,
        p.quantity,
        p.min_stock,
        p.supplier_id,
        p.brand,
        p.model,
        p.ram,
        p.storage,
        p.color,
        p.accessory_type,
        p.compatible_with,
        id
      ]);

      if (!rows[0]) {
        fail(404, 'Product not found');
      }

      return M.Product.from(rows[0]);

    } catch (err) {
      if (err.code === '23505') {
        fail(409, 'SKU already exists');
      }

      throw err;
    }
  },

  async remove(id) {
    const result = await pool.query(
      'DELETE FROM products WHERE id = $1',
      [id]
    );

    if (!result.rowCount) {
      fail(404, 'Product not found');
    }

    return { ok: true };
  }
};

// --------------------------------------------------
// CUSTOMERS AND SUPPLIERS
// --------------------------------------------------

function makeParty(table, Class) {

  return {

    async list() {
      const { rows } = await pool.query(
        `SELECT * FROM ${table} ORDER BY name`
      );

      return rows.map(row => new Class(row));
    },

    async save(data) {
      const id = data.id ? int(data.id, 'ID') : null;

      const name = required(data.name, 'Name');

      const values = [
        name,
        text(data.phone),
        text(data.email),
        text(data.address)
      ];

      if (id) {
        const { rows } = await pool.query(`
          UPDATE ${table}
          SET name=$1, phone=$2, email=$3, address=$4
          WHERE id=$5
          RETURNING *
        `, [...values, id]);

        if (!rows[0]) {
          fail(404, `${Class.name} not found`);
        }

        return new Class(rows[0]);
      }

      const { rows } = await pool.query(`
        INSERT INTO ${table}
        (name, phone, email, address)
        VALUES ($1,$2,$3,$4)
        RETURNING *
      `, values);

      return new Class(rows[0]);
    },

    async remove(id) {
      const result = await pool.query(
        `DELETE FROM ${table} WHERE id=$1`,
        [id]
      );

      if (!result.rowCount) {
        fail(404, `${Class.name} not found`);
      }

      return { ok: true };
    },

    async history(id) {
      if (table === 'customers') {
        const { rows } = await pool.query(`
          SELECT *
          FROM sales
          WHERE customer_id=$1
          ORDER BY sale_date DESC
        `, [id]);

        return rows;
      }

      const { rows } = await pool.query(`
        SELECT *
        FROM purchases
        WHERE supplier_id=$1
        ORDER BY purchase_date DESC
      `, [id]);

      return rows;
    }
  };
}

const Customers = makeParty('customers', M.Customer);
const Suppliers = makeParty('suppliers', M.Supplier);

// --------------------------------------------------
// SALES
// --------------------------------------------------

const Sales = {

  async create(data, user) {

    return transaction(async (client) => {

      const sale = new M.Sale();

      sale.discount = money(
        data.discount ?? 0,
        'Discount'
      );

      sale.paymentMethod = required(
        data.payment_method ?? data.paymentMethod ?? 'Cash',
        'Payment method'
      );

      sale.createdBy =
        user?.fullName ||
        user?.full_name ||
        user?.username ||
        '';

      const customerId =
        data.customer_id ?? data.customerId ?? null;

      if (customerId) {
        const c = await client.query(
          'SELECT name FROM customers WHERE id=$1',
          [customerId]
        );

        if (!c.rows[0]) {
          fail(400, 'Customer not found');
        }

        sale.customerId = Number(customerId);
        sale.customerName = c.rows[0].name;
      }

      const items = Array.isArray(data.items) ? data.items : [];

      if (!items.length) {
        fail(400, 'Sale must contain at least one item');
      }

      for (const item of items) {

        const productId = int(
          item.product_id ?? item.productId,
          'Product ID'
        );

        const quantity = int(item.quantity, 'Quantity');

        const found = await client.query(
          'SELECT * FROM products WHERE id=$1 FOR UPDATE',
          [productId]
        );

        const product = found.rows[0];

        if (!product) {
          fail(404, `Product ${productId} not found`);
        }

        if (product.quantity < quantity) {
          fail(400, `Insufficient stock for ${product.name}`);
        }

        sale.addItem(
          M.Product.from(product),
          quantity
        );
      }

      if (sale.discount > sale.subtotal) {
        fail(400, 'Discount cannot exceed subtotal');
      }

      const { rows } = await client.query(`
        INSERT INTO sales (
          customer_id,
          subtotal,
          discount,
          total,
          payment_method,
          created_by
        )
        VALUES ($1,$2,$3,$4,$5,$6)
        RETURNING *
      `, [
        sale.customerId,
        sale.subtotal,
        sale.discount,
        sale.total,
        sale.paymentMethod,
        sale.createdBy
      ]);

      const saved = rows[0];

      for (const item of sale.items) {

        await client.query(`
          UPDATE products
          SET
            quantity = quantity - $1,
            total_sold = total_sold + $1
          WHERE id = $2
        `, [item.quantity, item.productId]);

        await client.query(`
          INSERT INTO sale_items (
            sale_id,
            product_id,
            product_name,
            quantity,
            unit_price,
            unit_cost
          )
          VALUES ($1,$2,$3,$4,$5,$6)
        `, [
          saved.id,
          item.productId,
          item.productName,
          item.quantity,
          item.unitPrice,
          item.unitCost
        ]);
      }

      return this.present(saved, sale.items);
    });
  },

  present(row, items) {
    return {
      id: row.id,
      customer_id: row.customer_id,
      customer_name: row.customer_name || 'Walk-in Customer',
      sale_date: row.sale_date,
      subtotal: num(row.subtotal),
      discount: num(row.discount),
      total: num(row.total),
      payment_method: row.payment_method,
      created_by: row.created_by,
      items: items || []
    };
  },

  async list() {
    const { rows } = await pool.query(`
      SELECT
        s.*,
        COALESCE(c.name, 'Walk-in Customer') AS customer_name,
        (
          SELECT COUNT(*)::int
          FROM sale_items si
          WHERE si.sale_id=s.id
        ) AS item_count
      FROM sales s
      LEFT JOIN customers c ON c.id=s.customer_id
      ORDER BY s.sale_date DESC
    `);

    return rows;
  },

  async get(id) {
    const { rows } = await pool.query(`
      SELECT
        s.*,
        COALESCE(c.name, 'Walk-in Customer') AS customer_name
      FROM sales s
      LEFT JOIN customers c ON c.id=s.customer_id
      WHERE s.id=$1
    `, [id]);

    if (!rows[0]) {
      fail(404, 'Sale not found');
    }

    const { rows: items } = await pool.query(`
      SELECT *
      FROM sale_items
      WHERE sale_id=$1
      ORDER BY id
    `, [id]);

    return this.present(
      rows[0],
      items.map(item => ({
        productId: item.product_id,
        productName: item.product_name,
        quantity: item.quantity,
        unitPrice: num(item.unit_price),
        unitCost: num(item.unit_cost),
        lineTotal: num(item.quantity) * num(item.unit_price)
      }))
    );
  }
};

// --------------------------------------------------
// PURCHASES
// --------------------------------------------------

const Purchases = {

  async create(data, user) {

    return transaction(async (client) => {

      const supplierId =
        data.supplier_id ?? data.supplierId ?? null;

      if (supplierId) {
        const s = await client.query(
          'SELECT id FROM suppliers WHERE id=$1',
          [supplierId]
        );

        if (!s.rows[0]) {
          fail(400, 'Supplier not found');
        }
      }

      const items = Array.isArray(data.items) ? data.items : [];

      if (!items.length) {
        fail(400, 'Purchase must contain at least one item');
      }

      let total = 0;
      const checked = [];

      for (const item of items) {

        const productId = int(
          item.product_id ?? item.productId,
          'Product ID'
        );

        const quantity = int(item.quantity, 'Quantity');

        const cost = money(
          item.unit_cost ?? item.unitCost ?? item.cost,
          'Unit cost'
        );

        const result = await client.query(
          'SELECT * FROM products WHERE id=$1 FOR UPDATE',
          [productId]
        );

        if (!result.rows[0]) {
          fail(404, `Product ${productId} not found`);
        }

        const product = result.rows[0];

        total += quantity * cost;

        checked.push({
          product,
          productId,
          quantity,
          cost
        });
      }

      const { rows } = await client.query(`
        INSERT INTO purchases (
          supplier_id,
          total,
          created_by
        )
        VALUES ($1,$2,$3)
        RETURNING *
      `, [
        supplierId,
        total,
        user?.fullName || user?.username || ''
      ]);

      const purchase = rows[0];

      for (const item of checked) {

        await client.query(`
          UPDATE products
          SET
            quantity = quantity + $1,
            total_purchased = total_purchased + $1,
            purchase_price = $2,
            supplier_id = COALESCE($3, supplier_id)
          WHERE id=$4
        `, [
          item.quantity,
          item.cost,
          supplierId,
          item.productId
        ]);

        await client.query(`
          INSERT INTO purchase_items (
            purchase_id,
            product_id,
            product_name,
            quantity,
            unit_cost
          )
          VALUES ($1,$2,$3,$4,$5)
        `, [
          purchase.id,
          item.productId,
          item.product.name,
          item.quantity,
          item.cost
        ]);
      }

      return {
        ...purchase,
        items: checked.map(item => ({
          product_id: item.productId,
          product_name: item.product.name,
          quantity: item.quantity,
          unit_cost: item.cost
        }))
      };
    });
  },

  async list() {
    const { rows } = await pool.query(`
      SELECT
        p.*,
        s.name AS supplier_name,
        (
          SELECT COUNT(*)::int
          FROM purchase_items pi
          WHERE pi.purchase_id=p.id
        ) AS item_count
      FROM purchases p
      LEFT JOIN suppliers s ON s.id=p.supplier_id
      ORDER BY p.purchase_date DESC
    `);

    return rows;
  },

  async get(id) {
    const { rows } = await pool.query(`
      SELECT
        p.*,
        s.name AS supplier_name
      FROM purchases p
      LEFT JOIN suppliers s ON s.id=p.supplier_id
      WHERE p.id=$1
    `, [id]);

    if (!rows[0]) {
      fail(404, 'Purchase not found');
    }

    const { rows: items } = await pool.query(`
      SELECT *
      FROM purchase_items
      WHERE purchase_id=$1
      ORDER BY id
    `, [id]);

    return {
      ...rows[0],
      items
    };
  }
};

// --------------------------------------------------
// REPORTS
// --------------------------------------------------


// --------------------------------------------------
// REPORTS
// --------------------------------------------------

const Reports = {

  async dashboard() {

    const [
      sales,
      products,
      customers,
      purchases,
      chart
    ] = await Promise.all([

      pool.query(`
        SELECT
          COUNT(*)::int AS transactions,
          COALESCE(SUM(total),0)::float AS revenue,
          COALESCE(SUM(discount),0)::float AS discounts
        FROM sales
        WHERE sale_date::date=CURRENT_DATE
      `),

      Products.summary(),

      pool.query(`
        SELECT COUNT(*)::int AS total
        FROM customers
      `),

      pool.query(`
        SELECT COALESCE(SUM(total),0)::float AS total
        FROM purchases
        WHERE purchase_date::date=CURRENT_DATE
      `),

      pool.query(`
        SELECT
          TO_CHAR(days.day,'YYYY-MM-DD') AS date,
          COALESCE(SUM(s.total),0)::float AS total
        FROM generate_series(
          CURRENT_DATE-6,
          CURRENT_DATE,
          INTERVAL '1 day'
        ) AS days(day)
        LEFT JOIN sales s
          ON s.sale_date::date=days.day::date
        GROUP BY days.day
        ORDER BY days.day
      `)
    ]);

    return {
      today: sales.rows[0],
      products: products,
      customers: customers.rows[0].total,
      purchases_today: purchases.rows[0].total,
      sales_chart: chart.rows
    };
  },

  async build(type = 'daily', filters = {}) {

    const mode = text(type || 'daily').toLowerCase();

    // LOW STOCK REPORT
    if (mode === 'low-stock' || mode === 'low_stock') {

      const { rows } = await pool.query(`
        SELECT
          sku,
          name,
          quantity,
          min_stock,
          sale_price
        FROM products
        WHERE quantity <= min_stock
        ORDER BY quantity, name
      `);

      return new M.Report(
        'Low Stock Report',
        ['SKU', 'Product', 'Quantity', 'Minimum Stock', 'Sale Price'],
        rows.map(row => Object.values(row))
      );
    }

    // INVENTORY REPORT
    if (mode === 'inventory' || mode === 'stock') {

      const { rows } = await pool.query(`
        SELECT
          sku,
          name,
          type,
          quantity,
          purchase_price,
          sale_price,
          (quantity * purchase_price) AS stock_value
        FROM products
        ORDER BY name
      `);

      return new M.Report(
        'Inventory Report',
        [
          'SKU',
          'Product',
          'Type',
          'Quantity',
          'Purchase Price',
          'Sale Price',
          'Stock Value'
        ],
        rows.map(row => Object.values(row))
      );
    }

    // DAILY, MONTHLY AND YEARLY REPORTS

    const start = filters.start_date || filters.startDate || null;
    const end = filters.end_date || filters.endDate || null;

    const where = [];
    const values = [];

    if (start) {
      values.push(start);
      where.push(`s.sale_date::date >= $${values.length}::date`);
    }

    if (end) {
      values.push(end);
      where.push(`s.sale_date::date <= $${values.length}::date`);
    }

    const dateFormat =
      mode === 'yearly' ? 'YYYY' :
      mode === 'monthly' ? 'YYYY-MM' :
      'YYYY-MM-DD';

    const sql = `
      WITH filtered_sales AS (
        SELECT
          s.id,
          s.sale_date,
          s.total,
          s.discount
        FROM sales s
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ),

      sales_summary AS (
        SELECT
          TO_CHAR(sale_date, '${dateFormat}') AS period,
          COUNT(*)::int AS transactions,
          COALESCE(SUM(total), 0)::float AS revenue,
          COALESCE(SUM(discount), 0)::float AS discounts
        FROM filtered_sales
        GROUP BY 1
      ),

      units_summary AS (
        SELECT
          TO_CHAR(fs.sale_date, '${dateFormat}') AS period,
          COALESCE(SUM(si.quantity), 0)::int AS units_sold
        FROM filtered_sales fs
        LEFT JOIN sale_items si ON si.sale_id = fs.id
        GROUP BY 1
      )

      SELECT
        ss.period,
        ss.transactions,
        ss.revenue,
        ss.discounts,
        COALESCE(us.units_sold, 0)::int AS units_sold
      FROM sales_summary ss
      LEFT JOIN units_summary us ON us.period = ss.period
      ORDER BY ss.period DESC
    `;

    const { rows } = await pool.query(sql, values);

    const title =
      mode === 'yearly' ? 'Yearly Sales Report' :
      mode === 'monthly' ? 'Monthly Sales Report' :
      'Daily Sales Report';

    return new M.Report(
      title,
      [
        'Period',
        'Transactions',
        'Revenue',
        'Discounts',
        'Units Sold'
      ],
      rows.map(row => [
        row.period,
        row.transactions,
        row.revenue,
        row.discounts,
        row.units_sold
      ])
    );
  }
};

// --------------------------------------------------
// EXPORTS
// --------------------------------------------------

module.exports = {
  pool,
  HttpError,
  hashPassword,
  verifyPassword,
  Users,
  Products,
  Customers,
  Suppliers,
  Sales,
  Purchases,
  Reports
};