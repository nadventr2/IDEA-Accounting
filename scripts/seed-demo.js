#!/usr/bin/env node
/**
 * Insert obviously fake demo rows. Refuses to run if the database already has customers.
 * Start the server once so it can create the schema, stop it, then run this.
 */
const sqlite3 = require('sqlite3').verbose();
const { loadConfig } = require('../server/load-config');

const cfg = loadConfig();
const db = new sqlite3.Database(cfg.databasePath);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

(async () => {
  const companies = await get("SELECT name FROM sqlite_master WHERE type='table' AND name='companies'");
  if (!companies) {
    console.error('Schema is not created yet. Start the server once, stop it, then run npm run seed:demo.');
    process.exit(1);
  }
  const existing = await get('SELECT COUNT(*) AS n FROM customers');
  if (existing && existing.n > 0) {
    console.error('Customers already exist. Refusing to seed over real data.');
    process.exit(1);
  }
  let company = await get('SELECT id FROM companies ORDER BY id LIMIT 1');
  if (!company) {
    const ins = await run(
      `INSERT INTO companies (name, dba_name, industry, bank_name) VALUES (?, ?, ?, ?)`,
      ['Example Widgets LLC', 'Example Widgets', 'Examples', 'Demo Bank']
    );
    company = { id: ins.lastID };
  } else {
    await run(
      `UPDATE companies SET name = ?, dba_name = ?, industry = ?, bank_name = ? WHERE id = ?`,
      ['Example Widgets LLC', 'Example Widgets', 'Examples', 'Demo Bank', company.id]
    );
  }
  const cid = company.id;
  const cust = await run(
    `INSERT INTO customers (name, email, phone, billing_address, shipping_address, company_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['Ada Example', 'ada@example.com', '555-0100', '1 Demo Street, Sample City', '1 Demo Street, Sample City', cid]
  );
  const prod = await run(
    `INSERT INTO products (sku, name, wholesale_price, retail_price, stock, company_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['DEMO-WIDGET', 'Demo Widget', 5, 12, 20, cid]
  );
  await run(
    `INSERT INTO sales (customer_id, date, subtotal, tax, tax_rate, shipping, discount, total, payment_method, transaction_number, company_id, notes, customer_name)
     VALUES (?, date('now'), 12, 0, 0, 0, 0, 12, 'Cash', ?, ?, ?, ?)`,
    [cust.lastID, 'DEMO-1001', cid, 'Sample sale. Not a real transaction.', 'Ada Example']
  );
  await run(
    `INSERT INTO sale_items (transaction_id, product_id, quantity, custom_price, wholesale_price, company_id)
     VALUES (last_insert_rowid(), ?, 1, 12, 5, ?)`,
    [prod.lastID, cid]
  );
  console.log('Seeded Example Widgets LLC demo rows into', cfg.databasePath);
  db.close();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
