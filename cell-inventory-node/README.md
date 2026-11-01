# Cell Inventory & Sales Management System (JavaScript / Node.js)

Mobile phone shop ke liye OOP project: products, inventory, purchases, sales, customers, suppliers,
invoices aur reports. **Backend:** Node.js + Express + SQLite. **GUI:** plain HTML/CSS/JavaScript (browser mein khulti hai).

**Team:** Rukhsar Rasheed & Rabia Noreen - BSCS 2nd Semester - Instructor: Sir Mohsin Ali Solangi

## 1. Chalane ka tareeqa (VS Code)

Zaroorat: **Node.js 18 ya naya** (https://nodejs.org, LTS version). MySQL ki zaroorat **nahi** hai, database khud ban jata hai.

1. Zip ko **Extract** karein.
2. VS Code mein **File -> Open Folder** se `cell-inventory-node` folder kholein (jis mein `package.json` ho).
3. **Terminal -> New Terminal** kholein aur ye chalayen:

```
npm install
npm start
```

4. Browser mein kholein: **http://localhost:3000**

Pehli dafa `npm install` internet se packages download karta hai. Server band karne ke liye terminal mein `Ctrl + C`.

### Demo logins
| Role  | Username | Password |
|-------|----------|----------|
| Admin | admin    | admin123 |
| Staff | staff    | staff123 |

Admin ko sab kuch milta hai. Sales staff sirf Dashboard, Products (sirf dekhna), Inventory, Sales & Invoices aur Customers use kar sakta hai.

## 2. Tests
```
npm test
```
In-memory database par 10 API tests chalte hain (login, permissions, sale, stock rollback, purchase, reports). Aap ka asli data safe rehta hai.

## 3. Screens (System Workflow)
Login -> Dashboard -> Products -> Inventory -> Purchases -> Sales -> Customers -> Suppliers -> Invoice -> Reports (+ Users for admin)

- **Dashboard** - aaj ki sale/profit, invoices, products, low-stock count, stock value, 7-din ka chart, low-stock alerts, recent sales.
- **Products** - phones aur accessories add / update / delete / search (type ke hisaab se alag fields).
- **Inventory** - stock, purchased, sold, stock value; low-stock rows laal; category aur low-stock filter.
- **Purchases** - supplier chunein, lines add karein, save karte hi stock barh jata hai. History tab.
- **Sales & Invoices** - cart, customer, discount, payment method; save par stock kam hota hai aur invoice khulta hai (Print / Save). History se purana invoice dobara khul sakta hai.
- **Customers / Suppliers** - contact records + transaction history.
- **Reports** - daily sales, monthly sales, monthly purchases, inventory, low stock, product-wise sales (profit ke saath). CSV export.
- **Users** - admin / staff accounts banana aur hatana.

## 4. OOP concepts (viva / report ke liye)
Sab classes `src/models.js` mein hain.

| Concept | Kahan |
|---|---|
| Encapsulation | Private fields (`#id`, `#quantity`...) + getters in `User`, `Product` |
| Inheritance | `User -> Admin, SalesStaff`; `Product -> MobilePhone, Accessory`; `Person -> Customer, Supplier`; `LineItem -> SaleItem, PurchaseItem` |
| Abstraction | `User`, `Product`, `Person`, `LineItem` abstract hain (seedha object nahi ban sakta); abstract methods subclass implement karti hai |
| Polymorphism | `canDelete()`, `canViewReports()` Admin aur SalesStaff mein alag behave karte hain; server `need('canViewReports')` se route protect karta hai; `describe()` phone vs accessory |
| Overriding | `role`, `can*()`, `type`, `describe()`, `kind` |
| Overloading | JavaScript mein true overloading nahi hoti, is liye `Sale.addItem(product, qty)` aur `Sale.addItem(saleItem)` dono forms ek hi method handle karta hai |
| Constructors | Har class ka constructor; `SaleItem.fromProduct()`, `Product.from(row)` factory methods |
| Aggregation | `Sale` mein `SaleItem`s; `Purchase` mein `PurchaseItem`s |

## 5. Project structure
```
server.js              Express server, login/session, route protection
src/models.js          Saari OOP classes (User, Product, Sale, Invoice, Report...)
src/db.js              SQLite schema, password hashing, sample data
src/services.js        Business logic (sales & purchases transactions, reports)
public/                GUI: index.html, style.css, app.js
test/api.test.js       Automated tests
docs/screenshots/      Presentation ke liye screenshots
data/                  Database file (pehli run par ban jati hai)
```

## 6. Important design points
- Sale/purchase **database transaction** mein hoti hai: agar stock kam ho to poori sale cancel (rollback) ho jati hai.
- Sale ki prices **server database se** leta hai, browser ki bheji hui price par bharosa nahi karta.
- Passwords `scrypt` se hash hote hain, plain text mein save nahi hote.
- Database reset karna ho to server band karke `data` folder delete kar dein.

## 7. Masla aaye to
- `npm` / `node` not recognized: Node.js install karke VS Code dobara kholein.
- `npm install` mein `better-sqlite3` error: Node.js ka LTS version install karein, phir `npm install` dobara chalayen.
- Port 3000 busy hai: `PORT=3001 npm start` (Windows PowerShell: `$env:PORT=3001; npm start`).
