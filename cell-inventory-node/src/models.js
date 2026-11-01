'use strict';
/**
 * OOP model layer.
 * Encapsulation  : private fields (#x) with getters
 * Inheritance    : User -> Admin/SalesStaff, Product -> MobilePhone/Accessory,
 *                  Person -> Customer/Supplier, LineItem -> SaleItem/PurchaseItem
 * Abstraction    : base classes throw if used directly / abstract methods not implemented
 * Polymorphism   : permission methods, describe(), kind
 * Overriding     : role, can*(), type, describe(), kind
 * Overloading    : JS has no overloading, so Sale.addItem() accepts (Product, qty) OR (SaleItem)
 */

function abstractGuard(instance, base) {
  if (new.target === base) throw new TypeError(`${base.name} is abstract and cannot be instantiated`);
}
function notImplemented(name) { throw new Error(`${name}() must be implemented by subclass`); }

// ---------------------------------------------------------------- Users
class User {
  #id; #username; #fullName;
  constructor({ id, username, full_name }) {
    if (new.target === User) throw new TypeError('User is abstract');
    this.#id = id; this.#username = username; this.#fullName = full_name;
  }
  get id() { return this.#id; }
  get username() { return this.#username; }
  get fullName() { return this.#fullName; }
  get role() { return notImplemented('role'); }
  canManageProducts() { return notImplemented('canManageProducts'); }
  canManagePurchases() { return notImplemented('canManagePurchases'); }
  canViewReports() { return notImplemented('canViewReports'); }
  canManageUsers() { return notImplemented('canManageUsers'); }
  canManageCustomers() { return notImplemented('canManageCustomers'); }
  canDelete() { return notImplemented('canDelete'); }
  permissions() {
    return {
      products: this.canManageProducts(), purchases: this.canManagePurchases(),
      reports: this.canViewReports(), users: this.canManageUsers(), delete: this.canDelete(),
    };
  }
  toJSON() {
    return { id: this.#id, username: this.#username, fullName: this.#fullName, role: this.role,
             permissions: this.permissions() };
  }
  static from(row) { return row.role === 'ADMIN' ? new Admin(row) : new SalesStaff(row); }
}
class Admin extends User {
  get role() { return 'ADMIN'; }
  canManageProducts() { return true; }
  canManagePurchases() { return true; }
  canViewReports() { return true; }
  canManageUsers() { return true; }
  canManageCustomers() { return true; }
  canDelete() { return true; }
}
class SalesStaff extends User {
  get role() { return 'STAFF'; }
  canManageProducts() { return false; }
  canManagePurchases() { return false; }
  canViewReports() { return false; }
  canManageUsers() { return false; }
  canManageCustomers() { return true; }
  canDelete() { return false; }
}

// ---------------------------------------------------------------- Products
class Product {
  #quantity;
  constructor(row) {
    if (new.target === Product) throw new TypeError('Product is abstract');
    Object.assign(this, {
      id: row.id, sku: row.sku, name: row.name, category: row.category || '',
      purchase_price: Number(row.purchase_price) || 0, sale_price: Number(row.sale_price) || 0,
      min_stock: Number(row.min_stock ?? 5), supplier_id: row.supplier_id || null,
      total_purchased: row.total_purchased || 0, total_sold: row.total_sold || 0,
    });
    this.#quantity = Number(row.quantity) || 0;
  }
  get quantity() { return this.#quantity; }
  get type() { return notImplemented('type'); }
  describe() { return notImplemented('describe'); }
  isLowStock() { return this.#quantity <= this.min_stock; }
  stockValue() { return this.#quantity * this.purchase_price; }
  toJSON() {
    return { ...this, quantity: this.#quantity, type: this.type, description: this.describe(),
             lowStock: this.isLowStock(), stockValue: this.stockValue() };
  }
  static from(row) {
    return row.type === 'PHONE' ? new MobilePhone(row) : new Accessory(row);
  }
}
class MobilePhone extends Product {
  constructor(row) {
    super(row);
    Object.assign(this, { brand: row.brand || '', model: row.model || '', ram: row.ram || '',
                          storage: row.storage || '', color: row.color || '' });
  }
  get type() { return 'PHONE'; }
  describe() { return `${this.brand} ${this.model} | ${this.ram}/${this.storage} | ${this.color}`; }
}
class Accessory extends Product {
  constructor(row) {
    super(row);
    Object.assign(this, { accessory_type: row.accessory_type || '', compatible_with: row.compatible_with || '' });
  }
  get type() { return 'ACCESSORY'; }
  describe() { return `${this.accessory_type} | Fits: ${this.compatible_with || '-'}`; }
}

// ---------------------------------------------------------------- Customers / Suppliers
class Person {
  constructor(row) {
    if (new.target === Person) throw new TypeError('Person is abstract');
    Object.assign(this, { id: row.id, name: row.name, phone: row.phone || '', email: row.email || '',
                          address: row.address || '' });
  }
  get kind() { return notImplemented('kind'); }
}
class Customer extends Person { get kind() { return 'Customer'; } }
class Supplier extends Person { get kind() { return 'Supplier'; } }

// ---------------------------------------------------------------- Line items, Sale, Purchase
class LineItem {
  constructor(productId, productName, quantity, unitPrice) {
    if (new.target === LineItem) throw new TypeError('LineItem is abstract');
    Object.assign(this, { productId, productName, quantity, unitPrice });
  }
  get lineTotal() { return this.quantity * this.unitPrice; }
}
class SaleItem extends LineItem {
  constructor(productId, productName, quantity, unitPrice, unitCost = 0) {
    super(productId, productName, quantity, unitPrice);
    this.unitCost = unitCost;
  }
  static fromProduct(p, qty) { return new SaleItem(p.id, p.name, qty, p.sale_price, p.purchase_price); }
}
class PurchaseItem extends LineItem {}

class Sale {
  constructor() {
    this.id = 0; this.customerId = null; this.customerName = 'Walk-in Customer';
    this.date = null; this.items = []; this.discount = 0; this.paymentMethod = 'Cash'; this.createdBy = '';
  }
  /** Overloaded: addItem(product, qty) or addItem(saleItem). Merges quantities of the same product. */
  addItem(a, qty) {
    const item = a instanceof SaleItem ? a : SaleItem.fromProduct(a, qty);
    const existing = this.items.find((i) => i.productId === item.productId);
    if (existing) existing.quantity += item.quantity; else this.items.push(item);
    return this;
  }
  get subtotal() { return this.items.reduce((s, i) => s + i.lineTotal, 0); }
  get total() { return Math.max(0, this.subtotal - this.discount); }
}
class Purchase {
  constructor() { this.id = 0; this.supplierId = null; this.items = []; this.createdBy = ''; this.date = null; }
  addItem(productId, name, qty, cost) { this.items.push(new PurchaseItem(productId, name, qty, cost)); return this; }
  get total() { return this.items.reduce((s, i) => s + i.lineTotal, 0); }
}

// ---------------------------------------------------------------- Invoice & Report
class Invoice {
  static W = 56;
  constructor(sale) { this.sale = sale; }
  get number() { return 'INV-' + String(this.sale.id).padStart(5, '0'); }
  render() {
    const W = Invoice.W, s = this.sale, line = (c) => c.repeat(W);
    const center = (t) => ' '.repeat(Math.max(0, Math.floor((W - t.length) / 2))) + t;
    const money = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const out = [center('CELL INVENTORY & SALES'), center('Mobile Phones & Accessories'), line('='),
      `Invoice : ${this.number}`, `Date    : ${s.date}`, `Customer: ${s.customerName}`,
      `Payment : ${s.paymentMethod}`, `Cashier : ${s.createdBy}`, line('-'),
      'Item'.padEnd(24) + ' ' + 'Qty'.padStart(4) + ' ' + 'Price'.padStart(12) + ' ' + 'Total'.padStart(12), line('-')];
    for (const i of s.items) {
      const name = i.productName.length > 24 ? i.productName.slice(0, 23) + '.' : i.productName;
      out.push(name.padEnd(24) + ' ' + String(i.quantity).padStart(4) + ' ' + money(i.unitPrice).padStart(12) +
               ' ' + money(i.lineTotal).padStart(12));
    }
    out.push(line('-'),
      'Subtotal'.padEnd(42) + ' ' + money(s.subtotal).padStart(12),
      'Discount'.padEnd(42) + ' ' + money(s.discount).padStart(12),
      'GRAND TOTAL (Rs)'.padEnd(42) + ' ' + money(s.total).padStart(12),
      line('='), center('Thank you for shopping with us!'));
    return out.join('\n');
  }
}
class Report {
  constructor(title, columns, rows = []) { this.title = title; this.columns = columns; this.rows = rows; }
  addRow(...cells) { this.rows.push(cells); return this; }
}

module.exports = { User, Admin, SalesStaff, Product, MobilePhone, Accessory, Person, Customer, Supplier,
  LineItem, SaleItem, PurchaseItem, Sale, Purchase, Invoice, Report };
