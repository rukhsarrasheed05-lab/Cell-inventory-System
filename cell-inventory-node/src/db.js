'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'cell_inventory.db');
if (DB_FILE !== ':memory:') require('fs').mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 32);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('ADMIN','STAFF')));
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT, email TEXT, address TEXT);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT, email TEXT, address TEXT);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('PHONE','ACCESSORY')), category TEXT,
  purchase_price REAL NOT NULL DEFAULT 0, sale_price REAL NOT NULL DEFAULT 0,
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0), min_stock INTEGER NOT NULL DEFAULT 5,
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  brand TEXT, model TEXT, ram TEXT, storage TEXT, color TEXT, accessory_type TEXT, compatible_with TEXT,
  total_purchased INTEGER NOT NULL DEFAULT 0, total_sold INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  sale_date TEXT NOT NULL DEFAULT (datetime('now','localtime')), subtotal REAL NOT NULL,
  discount REAL NOT NULL DEFAULT 0, total REAL NOT NULL, payment_method TEXT NOT NULL, created_by TEXT);
CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL, product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL, unit_price REAL NOT NULL, unit_cost REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  purchase_date TEXT NOT NULL DEFAULT (datetime('now','localtime')), total REAL NOT NULL, created_by TEXT);
CREATE TABLE IF NOT EXISTS purchase_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL, product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL, unit_cost REAL NOT NULL);
`);

function seed() {
  const count = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  if (count('users') === 0) {
    const ins = db.prepare('INSERT INTO users(username,password_hash,full_name,role) VALUES(?,?,?,?)');
    ins.run('admin', hashPassword('admin123'), 'Shop Owner', 'ADMIN');
    ins.run('staff', hashPassword('staff123'), 'Sales Staff', 'STAFF');
  }
  if (count('suppliers') === 0) {
    const s = db.prepare('INSERT INTO suppliers(name,phone,email,address) VALUES(?,?,?,?)');
    s.run('Karachi Mobile Traders', '0300-1234567', 'sales@kmt.example', 'Saddar, Karachi');
    s.run('Gadget Hub Distributors', '0321-7654321', 'info@gadgethub.example', 'Hafeez Centre, Lahore');
    const c = db.prepare('INSERT INTO customers(name,phone,email,address) VALUES(?,?,?,?)');
    c.run('Ali Raza', '0333-1112233', 'ali@example.com', 'Gulshan, Karachi');
    c.run('Sara Khan', '0345-9988776', 'sara@example.com', 'Clifton, Karachi');
  }
  if (count('products') === 0) {
    const p = db.prepare(`INSERT INTO products(sku,name,type,category,purchase_price,sale_price,quantity,min_stock,
      supplier_id,brand,model,ram,storage,color,accessory_type,compatible_with,total_purchased)
      VALUES(@sku,@name,@type,@category,@buy,@sell,@qty,@min,1,@brand,@model,@ram,@storage,@color,@acc,@compat,@qty)`);
    const blank = { brand: null, model: null, ram: null, storage: null, color: null, acc: null, compat: null };
    const rows = [
      { sku: 'PH-001', name: 'Galaxy A15', type: 'PHONE', category: 'Smartphone', buy: 42000, sell: 46500, qty: 12, min: 5,
        ...blank, brand: 'Samsung', model: 'A15', ram: '6GB', storage: '128GB', color: 'Blue' },
      { sku: 'PH-002', name: 'Redmi Note 13', type: 'PHONE', category: 'Smartphone', buy: 48000, sell: 52999, qty: 8, min: 4,
        ...blank, brand: 'Xiaomi', model: 'Note 13', ram: '8GB', storage: '256GB', color: 'Black' },
      { sku: 'PH-003', name: 'iPhone 13', type: 'PHONE', category: 'Smartphone', buy: 165000, sell: 178000, qty: 3, min: 3,
        ...blank, brand: 'Apple', model: 'iPhone 13', ram: '4GB', storage: '128GB', color: 'Midnight' },
      { sku: 'AC-001', name: '20W Fast Charger', type: 'ACCESSORY', category: 'Charger', buy: 900, sell: 1500, qty: 40, min: 10,
        ...blank, acc: 'Charger', compat: 'USB-C devices' },
      { sku: 'AC-002', name: 'Tempered Glass Protector', type: 'ACCESSORY', category: 'Screen Protector', buy: 80, sell: 250,
        qty: 6, min: 15, ...blank, acc: 'Screen Protector', compat: 'Universal' },
      { sku: 'AC-003', name: 'Wireless Earbuds', type: 'ACCESSORY', category: 'Audio', buy: 2500, sell: 3999, qty: 15, min: 5,
        ...blank, acc: 'Earbuds', compat: 'Bluetooth devices' },
    ];
    db.transaction(() => rows.forEach((r) => p.run(r)))();
  }
}
seed();

module.exports = { db, hashPassword, verifyPassword, seed };
