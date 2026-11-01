'use strict';
const { db, hashPassword, verifyPassword } = require('./db');
const M = require('./models');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);

// ---------- validation helpers
const int = (v, name, { min = 0 } = {}) => {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isInteger(n) || n < min) throw bad(`${name} must be a whole number (>= ${min}).`);
  return n;
};
const money = (v, name) => {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(n) || n < 0) throw bad(`${name} must be a number (>= 0).`);
  return n;
};
const text = (v) => (v == null ? '' : String(v).trim());
const required = (v, name) => { const t = text(v); if (!t) throw bad(`${name} is required.`); return t; };

// ================================================================= Users
const Users = {
  authenticate(username, password) {
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(text(username));
    if (!row || !verifyPassword(String(password || ''), row.password_hash)) return null;
    return M.User.from(row);
  },
  byId(id) {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    return row ? M.User.from(row) : null;
  },
  all: () => db.prepare('SELECT * FROM users ORDER BY id').all().map((r) => M.User.from(r)),
  create({ fullName, username, password, role }) {
    required(fullName, 'Full name'); required(username, 'Username');
    if (String(password || '').length < 4) throw bad('Password must be at least 4 characters.');
    try {
      db.prepare('INSERT INTO users(username,password_hash,full_name,role) VALUES(?,?,?,?)')
        .run(text(username), hashPassword(password), text(fullName), role === 'ADMIN' ? 'ADMIN' : 'STAFF');
    } catch (e) {
      if (String(e.code).startsWith('SQLITE_CONSTRAINT')) throw bad('That username is already taken.');
      throw e;
    }
  },
  remove(id, currentId) {
    if (Number(id) === currentId) throw bad('You cannot delete the account you are logged in with.');
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  },
};

// ================================================================= Products / Inventory
const Products = {
  list({ q, lowOnly, category, inStock } = {}) {
    const where = [], args = [];
    if (q) {
      where.push('(sku LIKE ? OR name LIKE ? OR category LIKE ? OR brand LIKE ? OR model LIKE ?)');
      args.push(...Array(5).fill(`%${q}%`));
    }
    if (lowOnly) where.push('quantity <= min_stock');
    if (inStock) where.push('quantity > 0');
    if (category) { where.push('category = ?'); args.push(category); }
    const sql = 'SELECT * FROM products' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY name';
    return db.prepare(sql).all(...args).map((r) => M.Product.from(r));
  },
  categories: () => db.prepare("SELECT DISTINCT category FROM products WHERE category <> '' ORDER BY category").all().map((r) => r.category),
  summary() {
    const all = Products.list();
    return { units: all.reduce((s, p) => s + p.quantity, 0), value: all.reduce((s, p) => s + p.stockValue(), 0) };
  },
  clean(b) {
    const type = b.type === 'ACCESSORY' ? 'ACCESSORY' : 'PHONE';
    const isPhone = type === 'PHONE';
    return {
      sku: required(b.sku, 'SKU'), name: required(b.name, 'Name'), type, category: text(b.category),
      purchase_price: money(b.purchase_price, 'Purchase price'), sale_price: money(b.sale_price, 'Sale price'),
      quantity: b.quantity === '' || b.quantity == null ? 0 : int(b.quantity, 'Quantity'),
      min_stock: b.min_stock === '' || b.min_stock == null ? 5 : int(b.min_stock, 'Minimum stock'),
      supplier_id: b.supplier_id ? int(b.supplier_id, 'Supplier') : null,
      brand: isPhone ? text(b.brand) : null, model: isPhone ? text(b.model) : null, ram: isPhone ? text(b.ram) : null,
      storage: isPhone ? text(b.storage) : null, color: isPhone ? text(b.color) : null,
      accessory_type: isPhone ? null : text(b.accessory_type), compatible_with: isPhone ? null : text(b.compatible_with),
    };
  },
  create(b) {
    const d = Products.clean(b);
    try {
      const r = db.prepare(`INSERT INTO products(sku,name,type,category,purchase_price,sale_price,quantity,min_stock,
        supplier_id,brand,model,ram,storage,color,accessory_type,compatible_with,total_purchased)
        VALUES(@sku,@name,@type,@category,@purchase_price,@sale_price,@quantity,@min_stock,@supplier_id,@brand,@model,
        @ram,@storage,@color,@accessory_type,@compatible_with,@quantity)`).run(d);
      return r.lastInsertRowid;
    } catch (e) { throw uniqueSku(e); }
  },
  update(id, b) {
    const d = Products.clean(b);
    try {
      const r = db.prepare(`UPDATE products SET sku=@sku,name=@name,type=@type,category=@category,
        purchase_price=@purchase_price,sale_price=@sale_price,quantity=@quantity,min_stock=@min_stock,
        supplier_id=@supplier_id,brand=@brand,model=@model,ram=@ram,storage=@storage,color=@color,
        accessory_type=@accessory_type,compatible_with=@compatible_with WHERE id=@id`).run({ ...d, id });
      if (!r.changes) throw new HttpError(404, 'Product not found.');
    } catch (e) { throw uniqueSku(e); }
  },
  remove: (id) => db.prepare('DELETE FROM products WHERE id = ?').run(id),
};
function uniqueSku(e) {
  return String(e.code).startsWith('SQLITE_CONSTRAINT_UNIQUE') ? bad('That SKU already exists.') : e;
}

// ================================================================= Customers / Suppliers
function makeParty(table, PersonClass, historySql, historyPrefix) {
  return {
    list(q) {
      const rows = q
        ? db.prepare(`SELECT * FROM ${table} WHERE name LIKE ? OR phone LIKE ? OR email LIKE ? ORDER BY name`).all(...Array(3).fill(`%${q}%`))
        : db.prepare(`SELECT * FROM ${table} ORDER BY name`).all();
      return rows.map((r) => new PersonClass(r));
    },
    save(id, b) {
      const d = { name: required(b.name, 'Name'), phone: text(b.phone), email: text(b.email), address: text(b.address) };
      if (id) db.prepare(`UPDATE ${table} SET name=@name,phone=@phone,email=@email,address=@address WHERE id=@id`).run({ ...d, id });
      else db.prepare(`INSERT INTO ${table}(name,phone,email,address) VALUES(@name,@phone,@email,@address)`).run(d);
    },
    remove: (id) => db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id),
    history: (id) => db.prepare(historySql).all(id).map((r) => ({ ...r, ref: historyPrefix + String(r.id).padStart(5, '0') })),
  };
}
const Customers = makeParty('customers', M.Customer,
  'SELECT id, sale_date AS date, total, payment_method AS note FROM sales WHERE customer_id = ? ORDER BY sale_date DESC, id DESC', 'INV-');
const Suppliers = makeParty('suppliers', M.Supplier,
  "SELECT id, purchase_date AS date, total, '' AS note FROM purchases WHERE supplier_id = ? ORDER BY purchase_date DESC, id DESC", 'PUR-');

// ================================================================= Sales
const Sales = {
  /** Builds a Sale from the cart, using prices from the database (never trusting the client), in one transaction. */
  create(body, user) {
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) throw bad('Add at least one product to the cart.');
    return db.transaction(() => {
      const sale = new M.Sale();
      for (const it of items) {
        const qty = int(it.quantity, 'Quantity', { min: 1 });
        const row = db.prepare('SELECT * FROM products WHERE id = ?').get(it.productId);
        if (!row) throw bad('A product in the cart no longer exists.');
        sale.addItem(M.Product.from(row), qty);
      }
      for (const it of sale.items) {
        const r = db.prepare('UPDATE products SET quantity = quantity - ?, total_sold = total_sold + ? WHERE id = ? AND quantity >= ?')
          .run(it.quantity, it.quantity, it.productId, it.quantity);
        if (!r.changes) throw bad(`Not enough stock for: ${it.productName}`);
      }
      sale.discount = body.discount === '' || body.discount == null ? 0 : money(body.discount, 'Discount');
      if (sale.discount > sale.subtotal) throw bad('Discount cannot be more than the subtotal.');
      sale.paymentMethod = text(body.paymentMethod) || 'Cash';
      sale.createdBy = user.fullName;
      let cust = null;
      if (body.customerId) {
        cust = db.prepare('SELECT * FROM customers WHERE id = ?').get(body.customerId);
        if (!cust) throw bad('Customer not found.');
        sale.customerId = cust.id; sale.customerName = cust.name;
      }
      const r = db.prepare('INSERT INTO sales(customer_id,subtotal,discount,total,payment_method,created_by) VALUES(?,?,?,?,?,?)')
        .run(sale.customerId, sale.subtotal, sale.discount, sale.total, sale.paymentMethod, sale.createdBy);
      sale.id = Number(r.lastInsertRowid);
      const ins = db.prepare('INSERT INTO sale_items(sale_id,product_id,product_name,quantity,unit_price,unit_cost) VALUES(?,?,?,?,?,?)');
      sale.items.forEach((i) => ins.run(sale.id, i.productId, i.productName, i.quantity, i.unitPrice, i.unitCost));
      sale.date = db.prepare('SELECT sale_date d FROM sales WHERE id = ?').get(sale.id).d;
      return Sales.present(sale);
    })();
  },
  present(sale) {
    const inv = new M.Invoice(sale);
    return { id: sale.id, number: inv.number, date: sale.date, customer: sale.customerName, payment: sale.paymentMethod,
             discount: sale.discount, subtotal: sale.subtotal, total: sale.total, createdBy: sale.createdBy,
             items: sale.items.map((i) => ({ ...i, lineTotal: i.lineTotal })), invoiceText: inv.render() };
  },
  list: () => db.prepare(`SELECT s.id, s.sale_date AS date, s.total, s.discount, s.payment_method AS payment, s.created_by AS createdBy,
      COALESCE(c.name,'Walk-in Customer') AS customer FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
      ORDER BY s.sale_date DESC, s.id DESC`).all().map((r) => ({ ...r, number: 'INV-' + String(r.id).padStart(5, '0') })),
  get(id) {
    const r = db.prepare(`SELECT s.*, COALESCE(c.name,'Walk-in Customer') AS cname FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id WHERE s.id = ?`).get(id);
    if (!r) throw new HttpError(404, 'Sale not found.');
    const sale = new M.Sale();
    Object.assign(sale, { id: r.id, customerId: r.customer_id, customerName: r.cname, date: r.sale_date,
      discount: r.discount, paymentMethod: r.payment_method, createdBy: r.created_by || '' });
    db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(id).forEach((i) =>
      sale.addItem(new M.SaleItem(i.product_id, i.product_name, i.quantity, i.unit_price, i.unit_cost)));
    return Sales.present(sale);
  },
};

// ================================================================= Purchases
const Purchases = {
  create(body, user) {
    const items = Array.isArray(body.items) ? body.items : [];
    if (!body.supplierId) throw bad('Select a supplier.');
    if (!items.length) throw bad('Add at least one line.');
    return db.transaction(() => {
      if (!db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(body.supplierId)) throw bad('Supplier not found.');
      const p = new M.Purchase();
      p.supplierId = Number(body.supplierId); p.createdBy = user.fullName;
      for (const it of items) {
        const qty = int(it.quantity, 'Quantity', { min: 1 });
        const cost = money(it.unitCost, 'Unit cost');
        const row = db.prepare('SELECT id, name FROM products WHERE id = ?').get(it.productId);
        if (!row) throw bad('A product in the list no longer exists.');
        p.addItem(row.id, row.name, qty, cost);
      }
      const r = db.prepare('INSERT INTO purchases(supplier_id,total,created_by) VALUES(?,?,?)').run(p.supplierId, p.total, p.createdBy);
      p.id = Number(r.lastInsertRowid);
      const ins = db.prepare('INSERT INTO purchase_items(purchase_id,product_id,product_name,quantity,unit_cost) VALUES(?,?,?,?,?)');
      const upd = db.prepare('UPDATE products SET quantity = quantity + ?, total_purchased = total_purchased + ?, purchase_price = ? WHERE id = ?');
      p.items.forEach((i) => { ins.run(p.id, i.productId, i.productName, i.quantity, i.unitPrice);
                               upd.run(i.quantity, i.quantity, i.unitPrice, i.productId); });
      return { id: p.id, number: 'PUR-' + String(p.id).padStart(5, '0'), total: p.total };
    })();
  },
  list: () => db.prepare(`SELECT p.id, p.purchase_date AS date, p.total, p.created_by AS createdBy,
      COALESCE(s.name,'-') AS supplier FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id
      ORDER BY p.purchase_date DESC, p.id DESC`).all().map((r) => ({ ...r, number: 'PUR-' + String(r.id).padStart(5, '0') })),
  get(id) {
    const p = db.prepare(`SELECT p.*, COALESCE(s.name,'-') AS supplier FROM purchases p
      LEFT JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = ?`).get(id);
    if (!p) throw new HttpError(404, 'Purchase not found.');
    const items = db.prepare('SELECT product_name AS productName, quantity, unit_cost AS unitCost, quantity*unit_cost AS lineTotal FROM purchase_items WHERE purchase_id = ?').all(id);
    return { id: p.id, number: 'PUR-' + String(p.id).padStart(5, '0'), date: p.purchase_date, supplier: p.supplier, total: p.total, items };
  },
};

// ================================================================= Reports & dashboard
const one = (sql, ...a) => db.prepare(sql).get(...a);
const Reports = {
  dashboard() {
    const today = "date('now','localtime')";
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const r = one(`SELECT date('now','localtime','-${i} day') d, COALESCE((SELECT SUM(total) FROM sales WHERE date(sale_date)=date('now','localtime','-${i} day')),0) t`);
      days.push({ date: r.d, total: r.t });
    }
    return {
      salesToday: one(`SELECT COALESCE(SUM(total),0) v FROM sales WHERE date(sale_date)=${today}`).v,
      invoicesToday: one(`SELECT COUNT(*) v FROM sales WHERE date(sale_date)=${today}`).v,
      profitToday: one(`SELECT COALESCE(SUM(si.quantity*(si.unit_price-si.unit_cost)),0) v FROM sale_items si
        JOIN sales s ON s.id=si.sale_id WHERE date(s.sale_date)=${today}`).v - one(`SELECT COALESCE(SUM(discount),0) v FROM sales WHERE date(sale_date)=${today}`).v,
      productCount: one('SELECT COUNT(*) v FROM products').v,
      lowStockCount: one('SELECT COUNT(*) v FROM products WHERE quantity <= min_stock').v,
      stockValue: Products.summary().value,
      last7: days,
      lowStock: Products.list({ lowOnly: true }).slice(0, 8).map((p) => p.toJSON()),
      recentSales: Sales.list().slice(0, 8),
    };
  },
  build(type, date, month) {
    const rows = (sql, ...a) => db.prepare(sql).raw().all(...a);
    const m = (n) => Number(n || 0).toFixed(2);
    switch (type) {
      case 'daily': {
        const r = new M.Report(`Daily Sales - ${date}`, ['Invoice', 'Time', 'Customer', 'Payment', 'Items', 'Total (Rs)'],
          rows(`SELECT 'INV-'||printf('%05d',s.id), time(s.sale_date), COALESCE(c.name,'Walk-in'), s.payment_method,
            (SELECT COALESCE(SUM(quantity),0) FROM sale_items WHERE sale_id=s.id), printf('%.2f',s.total)
            FROM sales s LEFT JOIN customers c ON c.id=s.customer_id WHERE date(s.sale_date)=? ORDER BY s.sale_date`, date));
        r.addRow('', '', '', '', 'TOTAL', m(one('SELECT COALESCE(SUM(total),0) v FROM sales WHERE date(sale_date)=?', date).v));
        return r;
      }
      case 'monthly':
        return new M.Report(`Monthly Sales - ${month}`, ['Date', 'Invoices', 'Units Sold', 'Net Revenue (Rs)'],
          rows(`SELECT date(sale_date), COUNT(*), (SELECT COALESCE(SUM(quantity),0) FROM sale_items WHERE sale_id IN
            (SELECT id FROM sales x WHERE date(x.sale_date)=date(s.sale_date))), printf('%.2f',SUM(total))
            FROM sales s WHERE strftime('%Y-%m',sale_date)=? GROUP BY date(sale_date) ORDER BY date(sale_date)`, month));
      case 'purchases': {
        const r = new M.Report(`Purchases - ${month}`, ['Purchase', 'Date', 'Supplier', 'Total (Rs)'],
          rows(`SELECT 'PUR-'||printf('%05d',p.id), p.purchase_date, COALESCE(s.name,'-'), printf('%.2f',p.total)
            FROM purchases p LEFT JOIN suppliers s ON s.id=p.supplier_id WHERE strftime('%Y-%m',p.purchase_date)=? ORDER BY p.purchase_date`, month));
        r.addRow('', '', 'TOTAL', m(one("SELECT COALESCE(SUM(total),0) v FROM purchases WHERE strftime('%Y-%m',purchase_date)=?", month).v));
        return r;
      }
      case 'inventory':
        return new M.Report('Inventory Report', ['SKU', 'Product', 'Type', 'In Stock', 'Purchased', 'Sold', 'Stock Value (Rs)'],
          rows("SELECT sku, name, type, quantity, total_purchased, total_sold, printf('%.2f',quantity*purchase_price) FROM products ORDER BY name"));
      case 'lowstock':
        return new M.Report('Low Stock Report', ['SKU', 'Product', 'In Stock', 'Minimum', 'Shortfall'],
          rows('SELECT sku, name, quantity, min_stock, MAX(min_stock-quantity,0) FROM products WHERE quantity <= min_stock ORDER BY quantity'));
      case 'product':
        return new M.Report('Product-wise Sales Report', ['Product', 'Units Sold', 'Revenue (Rs)', 'Profit (Rs)'],
          rows(`SELECT product_name, SUM(quantity), printf('%.2f',SUM(quantity*unit_price)),
            printf('%.2f',SUM(quantity*(unit_price-unit_cost))) FROM sale_items GROUP BY product_name ORDER BY SUM(quantity*unit_price) DESC`));
      default: throw bad('Unknown report type.');
    }
  },
};

module.exports = { HttpError, Users, Products, Customers, Suppliers, Sales, Purchases, Reports };
