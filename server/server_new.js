// Accounting_system  Server_new.js

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const { DateTime } = require('luxon');
const {
  initBooksSchema,
  registerBooksRoutes,
  getBooksPnlExtras,
} = require('./books-module');
const {
  initEasycartSchema,
  registerEasycartRoutes,
} = require('./easycart-import-module');
const {
  initCompanySettingsSchema,
  registerCompanyRoutes,
} = require('./company-settings');
const { loadConfig } = require('./load-config');
const appConfig = loadConfig();
const app = express();
// ==== FINAL, BULLETPROOF, ZERO-CORS, ZERO-ERRORS FIX ====
// Put this right after app = express(); and delete ALL other CORS/cache attempts
app.use(cors({ origin: true, credentials: true }));
// Fix direct access from raw IP / localhost
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.options('*', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(204).send();
});

app.use(express.json());
// Fix NS_BINDING_ABORTED by adding cache headers
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
// === MAKE CODE-SERVER PROXY + DIRECT ACCESS BOTH WORK FOREVER ===
app.use((req, res, next) => {
  if (req.path.startsWith('/proxy/3003')) {
    req.url = req.url.replace(/^\/proxy\/3003/, '');
  }
  next();
});

// Branding uploads: company-logo-{id}.* or company-favicon-{id}.*
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, appConfig.uploadDir);
  },
  filename: (req, file, cb) => {
    const companyId = parseInt(req.body.company_id || req.query.company_id || '1', 10) || 1;
    const kind = String(req.body.kind || req.query.kind || 'logo').toLowerCase() === 'favicon'
      ? 'favicon'
      : 'logo';
    let ext = '.png';
    if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/jpg') ext = '.jpg';
    else if (file.mimetype === 'image/webp') ext = '.webp';
    else if (file.mimetype === 'image/x-icon' || file.mimetype === 'image/vnd.microsoft.icon') ext = '.ico';
    else if (file.originalname && /\.ico$/i.test(file.originalname)) ext = '.ico';
    // Keep legacy single-file name if explicitly requested
    if (req.body.as_default === '1' || req.body.as_default === 'true') {
      cb(null, (kind === 'favicon' ? 'favicon' : 'logo') + ext);
      return;
    }
    cb(null, 'company-' + kind + '-' + companyId + ext);
  }
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ok = [
      'image/png', 'image/jpeg', 'image/jpg', 'image/webp',
      'image/x-icon', 'image/vnd.microsoft.icon',
    ].includes(file.mimetype)
      || (file.originalname && /\.(png|jpe?g|webp|ico)$/i.test(file.originalname));
    if (ok) cb(null, true);
    else cb(new Error('Only PNG, JPG, WebP, or ICO images are allowed'));
  },
  limits: { fileSize: 2 * 1024 * 1024 }
});
// Database connection. Relative paths resolve from the project root (see load-config.js).
const DB_PATH = appConfig.databasePath;
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(appConfig.uploadDir, { recursive: true });
fs.mkdirSync(appConfig.backupDir, { recursive: true });
const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
  if (err) {
    console.error('Database open error:', err.message, DB_PATH);
    process.exit(1);
  } else {
    console.log('Connected to accounting.db at', DB_PATH);
    // Enforce FK on every connection (sqlite defaults off)
    db.run('PRAGMA foreign_keys = ON', (fkErr) => {
      if (fkErr) console.error('[DB] PRAGMA foreign_keys failed:', fkErr.message);
      else console.log('[DB] foreign_keys=ON');
    });
    db.run('PRAGMA busy_timeout = 5000');
    // Clean orphan line items left by older racey sale inserts
    db.run(
      'DELETE FROM sale_items WHERE transaction_id NOT IN (SELECT id FROM sales)',
      function (cleanErr) {
        if (cleanErr) console.error('[DB] orphan sale_items cleanup failed:', cleanErr.message);
        else if (this.changes > 0) console.log('[DB] Removed orphan sale_items:', this.changes);
      }
    );
    initBooksSchema(db);
    initEasycartSchema(db);
    initCompanySettingsSchema(db).then(() => {
      console.log('[DB] Company settings schema ready');
    });
    console.log('[DB] Books module schema ready');
    console.log('[DB] EasyCart import schema ready');
  }
});

// Promise helpers for report queries + transactional sale/stock work
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

/** Ship-to precedence: explicit override → customer shipping → customer billing */
function resolveShipTo(parts = {}) {
  const candidates = [
    parts.override,
    parts.sale_shipping,
    parts.invoice_shipping,
    parts.packing_shipping,
    parts.customer_shipping,
    parts.shipping_address,
    parts.customer_billing,
    parts.billing_address
  ];
  for (const c of candidates) {
    if (c != null && String(c).trim() !== '') return String(c).trim();
  }
  return '';
}

function normalizeEmail(e) {
  return String(e || '').trim().toLowerCase();
}
function normalizePhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length >= 10) return d.slice(-10);
  return d.length >= 7 ? d : '';
}
function normalizeAddress(a) {
  return String(a || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Adjust product stock and log inventory_transactions.
 * delta: + for receive/return, - for sale.
 * quantity logged as absolute value; type describes direction.
 */
async function adjustStock(productId, companyId, delta, type, date, notes) {
  const qty = Number(delta) || 0;
  if (!productId || qty === 0) return;
  await dbRun(
    'UPDATE products SET stock = COALESCE(stock, 0) + ? WHERE id = ? AND company_id = ?',
    [qty, productId, companyId]
  );
  await dbRun(
    `INSERT INTO inventory_transactions
      (purchase_order_id, product_id, quantity, transaction_type, transaction_date, company_id, notes)
     VALUES (NULL, ?, ?, ?, ?, ?, ?)`,
    [productId, Math.abs(qty), type, date || new Date().toISOString().slice(0, 10), companyId, notes || null]
  );
}

/** Apply stock deltas for a list of {product_id, quantity} — multiplies sign (-1 sale, +1 restore) */
async function applySaleStockDeltas(items, companyId, sign, date, notePrefix) {
  const byProduct = new Map();
  for (const it of items || []) {
    const pid = it.product_id;
    const q = parseInt(it.quantity, 10) || 0;
    if (!pid || q === 0) continue;
    byProduct.set(pid, (byProduct.get(pid) || 0) + q);
  }
  for (const [pid, q] of byProduct.entries()) {
    const prod = await dbGet('SELECT item_kind FROM products WHERE id = ? AND company_id = ?', [pid, companyId]);
    if (prod && String(prod.item_kind || '').toLowerCase() === 'service') continue;
    const delta = sign * q;
    const type = delta < 0 ? 'sale' : 'sale_return';
    await adjustStock(pid, companyId, delta, type, date, notePrefix || null);
  }
}

/** Resolve report date range from query: period and/or startDate/endDate (YYYY-MM-DD). */
function resolveReportRange(query) {
  const zone = 'America/Los_Angeles';
  const now = DateTime.now().setZone(zone).startOf('day');
  let start;
  let end;
  const period = (query.period || '').toString();
  if (query.startDate && query.endDate) {
    start = DateTime.fromISO(String(query.startDate), { zone });
    end = DateTime.fromISO(String(query.endDate), { zone });
  } else if (period === 'this_month') {
    start = now.startOf('month');
    end = now.endOf('month');
  } else if (period === 'last_month') {
    start = now.minus({ months: 1 }).startOf('month');
    end = now.minus({ months: 1 }).endOf('month');
  } else if (period === 'ytd') {
    // Year to date: Jan 1 of current year through today (not last year)
    start = now.startOf('year');
    end = now;
  } else if (period === 'this_year' || period === 'current_year') {
    // Full calendar year for the current year (through today for open year)
    start = now.startOf('year');
    end = now;
  } else if (period === 'last_year') {
    start = now.minus({ years: 1 }).startOf('year');
    end = now.minus({ years: 1 }).endOf('year');
  } else if (period === 'last_12_months' || period === 'trailing_12') {
    start = now.minus({ months: 11 }).startOf('month');
    end = now.endOf('month');
  } else if (period === 'last_quarter') {
    const q = Math.floor((now.month - 1) / 3); // 0-3 current quarter index
    const lastQEndMonth = q === 0 ? 12 : q * 3;
    const lastQStartMonth = lastQEndMonth - 2;
    const year = q === 0 ? now.year - 1 : now.year;
    start = DateTime.fromObject({ year, month: lastQStartMonth, day: 1 }, { zone });
    end = start.endOf('month').plus({ months: 2 }).endOf('month');
  } else if (period === 'this_quarter') {
    const qStartMonth = Math.floor((now.month - 1) / 3) * 3 + 1;
    start = DateTime.fromObject({ year: now.year, month: qStartMonth, day: 1 }, { zone });
    end = now;
  } else {
    // default: this year to date
    start = now.startOf('year');
    end = now;
  }
  if (!start || !start.isValid || !end || !end.isValid) {
    start = now.startOf('year');
    end = now;
  }
  return {
    startDate: start.toFormat('yyyy-MM-dd'),
    endDate: end.toFormat('yyyy-MM-dd'),
    period: period || 'custom',
    label: `${start.toFormat('yyyy-MM-dd')} → ${end.toFormat('yyyy-MM-dd')}`,
  };
}
// Helper functions
function generateTransactionNumber(date) {
  const dateStr = date.replace(/-/g, '').slice(2);
  const randomNum = Math.floor(1000 + Math.random() * 9000);
  return dateStr + '-' + randomNum;
}
function isValidDate(date) {
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  if (!regex.test(date)) return false;
  const dateObj = DateTime.fromISO(date, { zone: 'America/Los_Angeles' });
  return dateObj.isValid;
}
function toPDTDate(dateStr) {
  const date = DateTime.fromISO(dateStr, { zone: 'America/Los_Angeles' });
  if (!date.isValid) return null;
  return date.toFormat('yyyy-MM-dd');
}
// Database schema setup
db.serialize(() => {
  // Drop bills_temp to ensure clean slate
  db.run('DROP TABLE IF EXISTS bills_temp', (err) => {
    if (err) {
      console.error('[DB] Error dropping bills_temp:', err.message);
    } else {
      console.log('[DB] Dropped bills_temp if it existed');
    }
  });

  // Create temporary bills table with paid column
  db.run(`
    CREATE TABLE IF NOT EXISTS bills_temp (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_id INTEGER,
      purchase_order_id INTEGER,
      bill_number TEXT NOT NULL UNIQUE,
      invoice_number TEXT,
      amount REAL NOT NULL,
      bill_date TEXT NOT NULL,
      due_date TEXT,
      is_inventory_bill BOOLEAN NOT NULL DEFAULT 0,
      expense_category_id INTEGER,
      payment_date TEXT,
      paid INTEGER DEFAULT 0,
      company_id INTEGER NOT NULL,
      FOREIGN KEY (vendor_id) REFERENCES vendors(id),
      FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id),
      FOREIGN KEY (expense_category_id) REFERENCES expense_categories(id),
      FOREIGN KEY (company_id) REFERENCES companies(id)
    )
  `, (err) => {
    if (err) {
      console.error('[DB] Error creating bills_temp:', err.message);
    } else {
      console.log('[DB] Created bills_temp table');
    }
  });

  // Copy data from bills to bills_temp, omitting id to avoid conflicts
  //db.run(`
  //  INSERT INTO bills_temp (
  //    vendor_id, purchase_order_id, bill_number, invoice_number, amount,
   //   bill_date, due_date, is_inventory_bill, expense_category_id, payment_date, company_id
   // )
  //  SELECT
   //   vendor_id, purchase_order_id, bill_number, invoice_number, amount,
  //    bill_date, due_date, is_inventory_bill, expense_category_id, payment_date, company_id
  //  FROM bills
 // `, (err) => {
  //  if (err) {
   //   console.error('[DB] Error migrating bills data:', err.message);
      // Log sample data to diagnose
   //   db.all('SELECT id, bill_number FROM bills LIMIT 5', (err, rows) => {
   //     if (err) {
  //        console.error('[DB] Error fetching sample bills:', err.message);
 //       } else {
  //        console.log('[DB] Sample bills data:', rows);
  //      }
  //    });
  //  } else {
  //    console.log('[DB] Migrated bills data to bills_temp');
      // Drop original bills table
  //    db.run('DROP TABLE IF EXISTS bills', (err) => {
  //      if (err) {
   //       console.error('[DB] Error dropping bills table:', err.message);
  //      } else {
  //        console.log('[DB] Dropped original bills table');
 //         // Rename bills_temp to bills
 //        db.run('ALTER TABLE bills_temp RENAME TO bills', (err) => {
 //           if (err) {
 //             console.error('[DB] Error renaming bills_temp to bills:', err.message);
 //           } else {
 //             console.log('[DB] Renamed bills_temp to bills');
 //           }
 //         });
 //       }
 //     });
 //   }
 // });

  // Ensure paid column exists for existing databases (safe if already added)
  db.run(`
    ALTER TABLE bills ADD COLUMN paid INTEGER DEFAULT 0
  `, (err) => {
    if (err && !err.message.includes('duplicate column name') && !err.message.includes('no such table')) {
      console.error('[DB] Error adding paid column:', err.message);
    } else if (!err) {
      console.log('[DB] Ensured paid column in bills table');
    }
  });
  db.run(`
    CREATE TABLE IF NOT EXISTS bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_id INTEGER,
      purchase_order_id INTEGER,
      bill_number TEXT NOT NULL UNIQUE,
      invoice_number TEXT,
      amount REAL NOT NULL,
      bill_date TEXT NOT NULL,
      due_date TEXT,
      is_inventory_bill BOOLEAN NOT NULL DEFAULT 0,
      expense_category_id INTEGER,
      payment_date TEXT,
      paid INTEGER DEFAULT 0,
      company_id INTEGER NOT NULL
    )
  `);

  // Other table creations (unchanged)
  db.run('CREATE TABLE IF NOT EXISTS companies (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)');
  db.run('CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT, phone TEXT, billing_address TEXT, shipping_address TEXT, company_id INTEGER NOT NULL, FOREIGN KEY (company_id) REFERENCES companies(id))');
  db.run('CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL UNIQUE, name TEXT NOT NULL, wholesale_price REAL, retail_price REAL NOT NULL, stock INTEGER, vendor_id INTEGER, company_id INTEGER NOT NULL, FOREIGN KEY (vendor_id) REFERENCES vendors(id), FOREIGN KEY (company_id) REFERENCES companies(id))');
  db.run('CREATE TABLE IF NOT EXISTS vendors (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, contact_name TEXT, email TEXT, phone TEXT, address TEXT, company_id INTEGER NOT NULL, FOREIGN KEY (company_id) REFERENCES companies(id))');
  db.run('CREATE TABLE IF NOT EXISTS sales (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, date TEXT NOT NULL, subtotal REAL NOT NULL, tax REAL NOT NULL, tax_rate REAL NOT NULL, shipping REAL NOT NULL, discount REAL NOT NULL, total REAL NOT NULL, payment_method TEXT NOT NULL, transaction_number TEXT NOT NULL UNIQUE, company_id INTEGER NOT NULL, notes TEXT, customer_name TEXT, FOREIGN KEY (customer_id) REFERENCES customers(id), FOREIGN KEY (company_id) REFERENCES companies(id))');
  db.run('CREATE TABLE IF NOT EXISTS sale_items (id INTEGER PRIMARY KEY AUTOINCREMENT, transaction_id INTEGER NOT NULL, product_id INTEGER NOT NULL, quantity INTEGER NOT NULL, custom_price REAL, wholesale_price REAL, company_id INTEGER NOT NULL, FOREIGN KEY (transaction_id) REFERENCES sales(id), FOREIGN KEY (product_id) REFERENCES products(id), FOREIGN KEY (company_id) REFERENCES companies(id))');
  db.run('CREATE TABLE IF NOT EXISTS purchase_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, po_number TEXT NOT NULL UNIQUE, vendor_id INTEGER, drop_ship_customer_id INTEGER, date_ordered TEXT NOT NULL, expected_delivery TEXT, status TEXT, created_date TEXT, notes TEXT, company_id INTEGER NOT NULL, FOREIGN KEY (vendor_id) REFERENCES vendors(id), FOREIGN KEY (drop_ship_customer_id) REFERENCES customers(id), FOREIGN KEY (company_id) REFERENCES companies(id))');
  db.run('CREATE TABLE IF NOT EXISTS purchase_order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, purchase_order_id INTEGER NOT NULL, product_id INTEGER NOT NULL, quantity INTEGER NOT NULL, unit_price REAL NOT NULL, received_quantity INTEGER DEFAULT 0, company_id INTEGER NOT NULL, FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id), FOREIGN KEY (product_id) REFERENCES products(id), FOREIGN KEY (company_id) REFERENCES companies(id))');
  db.run('CREATE TABLE IF NOT EXISTS expense_categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, company_id INTEGER NOT NULL, FOREIGN KEY (company_id) REFERENCES companies(id))');
  db.run('CREATE TABLE IF NOT EXISTS sales_tax_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, year INTEGER NOT NULL, paid BOOLEAN NOT NULL, payment_date TEXT, company_id INTEGER NOT NULL, FOREIGN KEY (company_id) REFERENCES companies(id))');
  // Live DB uses payment_date (not camelCase paymentDate)
  db.run('ALTER TABLE sales_tax_payments ADD COLUMN payment_date TEXT', () => {});
  db.run('ALTER TABLE sales_tax_payments ADD COLUMN company_id INTEGER', () => {});
  db.run('CREATE TABLE IF NOT EXISTS inventory (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, quantity INTEGER NOT NULL, company_id INTEGER NOT NULL, FOREIGN KEY (product_id) REFERENCES products(id), FOREIGN KEY (company_id) REFERENCES companies(id))');
  db.run('CREATE TABLE IF NOT EXISTS inventory_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, total_value REAL NOT NULL, snapshot_date TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, company_id INTEGER NOT NULL, FOREIGN KEY (company_id) REFERENCES companies(id))');
  db.run('CREATE TABLE IF NOT EXISTS accounting_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, transaction_type TEXT NOT NULL, amount REAL NOT NULL, date TEXT NOT NULL, description TEXT, company_id INTEGER NOT NULL, FOREIGN KEY (company_id) REFERENCES companies(id))');
  db.run('CREATE TABLE IF NOT EXISTS inventory_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, purchase_order_id INTEGER, product_id INTEGER NOT NULL, quantity INTEGER NOT NULL, transaction_type TEXT NOT NULL, transaction_date TEXT NOT NULL, company_id INTEGER NOT NULL, FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id), FOREIGN KEY (product_id) REFERENCES products(id), FOREIGN KEY (company_id) REFERENCES companies(id))');
  db.run('CREATE TABLE IF NOT EXISTS deposits (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, amount REAL NOT NULL, type TEXT NOT NULL, date TEXT NOT NULL, description TEXT, company_id INTEGER NOT NULL, FOREIGN KEY (customer_id) REFERENCES customers(id), FOREIGN KEY (company_id) REFERENCES companies(id))');
  db.run('CREATE TABLE IF NOT EXISTS expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, vendor_id INTEGER NOT NULL, category_id INTEGER NOT NULL, amount REAL NOT NULL, date TEXT NOT NULL, description TEXT, company_id INTEGER NOT NULL, FOREIGN KEY (vendor_id) REFERENCES vendors(id), FOREIGN KEY (category_id) REFERENCES expense_categories(id), FOREIGN KEY (company_id) REFERENCES companies(id))');
  db.run('CREATE TABLE IF NOT EXISTS estimates (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, date TEXT NOT NULL, subtotal REAL NOT NULL, tax REAL NOT NULL, tax_rate REAL NOT NULL, shipping REAL NOT NULL, discount REAL NOT NULL, total REAL NOT NULL, payment_method TEXT NOT NULL, estimate_number TEXT NOT NULL UNIQUE, company_id INTEGER NOT NULL, notes TEXT, customer_name TEXT, status TEXT NOT NULL, FOREIGN KEY (customer_id) REFERENCES customers(id), FOREIGN KEY (company_id) REFERENCES companies(id))');
  db.run('CREATE TABLE IF NOT EXISTS estimate_items (id INTEGER PRIMARY KEY AUTOINCREMENT, transaction_id INTEGER NOT NULL, product_id INTEGER NOT NULL, quantity INTEGER NOT NULL, custom_price REAL, wholesale_price REAL, company_id INTEGER NOT NULL, FOREIGN KEY (transaction_id) REFERENCES estimates(id), FOREIGN KEY (product_id) REFERENCES products(id), FOREIGN KEY (company_id) REFERENCES companies(id))');
  db.run('CREATE TABLE IF NOT EXISTS invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, date TEXT NOT NULL, subtotal REAL NOT NULL, tax REAL NOT NULL, tax_rate REAL NOT NULL, shipping REAL NOT NULL, discount REAL NOT NULL, total REAL NOT NULL, payment_method TEXT NOT NULL, invoice_number TEXT NOT NULL UNIQUE, company_id INTEGER NOT NULL, notes TEXT, customer_name TEXT, status TEXT NOT NULL, FOREIGN KEY (customer_id) REFERENCES customers(id), FOREIGN KEY (company_id) REFERENCES companies(id))');
  db.run('CREATE TABLE IF NOT EXISTS invoice_items (id INTEGER PRIMARY KEY AUTOINCREMENT, transaction_id INTEGER NOT NULL, product_id INTEGER NOT NULL, quantity INTEGER NOT NULL, custom_price REAL, wholesale_price REAL, company_id INTEGER NOT NULL, FOREIGN KEY (transaction_id) REFERENCES invoices(id), FOREIGN KEY (product_id) REFERENCES products(id), FOREIGN KEY (company_id) REFERENCES companies(id))');
  // Add source column to sales table
  db.run('ALTER TABLE sales ADD COLUMN source TEXT DEFAULT "direct"', (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('[DB] Error adding source column:', err.message);
    } else {
      console.log('[DB] Added source column to sales table');
    }
  });
  // Per-sale shipping address (one-time or override; does not require changing customer record)
  db.run('ALTER TABLE sales ADD COLUMN shipping_address TEXT', (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('[DB] Error adding sales.shipping_address column:', err.message);
    } else if (!err) {
      console.log('[DB] Added shipping_address column to sales table');
    }
  });
  db.run('ALTER TABLE invoices ADD COLUMN shipping_address TEXT', (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('[DB] Error adding invoices.shipping_address:', err.message);
    } else if (!err) {
      console.log('[DB] Added shipping_address column to invoices table');
    }
  });
  db.run('ALTER TABLE estimates ADD COLUMN shipping_address TEXT', (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('[DB] Error adding estimates.shipping_address:', err.message);
    } else if (!err) {
      console.log('[DB] Added shipping_address column to estimates table');
    }
  });
  db.run('ALTER TABLE invoices ADD COLUMN customer_po TEXT', (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('[DB] Error adding invoices.customer_po:', err.message);
    } else if (!err) {
      console.log('[DB] Added customer_po column to invoices table');
    }
  });

  // Packing slips: multi-box lines + optional source invoice
  db.run(`
    CREATE TABLE IF NOT EXISTS packing_slips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slip_number TEXT NOT NULL UNIQUE,
      customer_id INTEGER NOT NULL,
      customer_po TEXT,
      date_shipped TEXT NOT NULL,
      shipping_address TEXT,
      notes TEXT,
      company_id INTEGER NOT NULL,
      tracking_number TEXT,
      invoice_id INTEGER,
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (company_id) REFERENCES companies(id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS packing_slip_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      packing_slip_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      company_id INTEGER NOT NULL,
      box_number INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (packing_slip_id) REFERENCES packing_slips(id),
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (company_id) REFERENCES companies(id)
    )
  `);
  db.run('ALTER TABLE packing_slip_items ADD COLUMN box_number INTEGER NOT NULL DEFAULT 1', (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('[DB] Error adding packing_slip_items.box_number:', err.message);
    } else if (!err) {
      console.log('[DB] Added box_number to packing_slip_items');
    }
  });
  db.run('ALTER TABLE packing_slips ADD COLUMN invoice_id INTEGER', (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('[DB] Error adding packing_slips.invoice_id:', err.message);
    } else if (!err) {
      console.log('[DB] Added invoice_id to packing_slips');
    }
  });
  db.run('ALTER TABLE packing_slips ADD COLUMN tracking_number TEXT', () => {});
  db.run('ALTER TABLE packing_slips ADD COLUMN sale_id INTEGER', (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('[DB] Error adding packing_slips.sale_id:', err.message);
    } else if (!err) {
      console.log('[DB] Added sale_id to packing_slips');
    }
  });
  // Update existing invoice-converted sales
  db.get('SELECT COUNT(*) AS count FROM invoices', (err, row) => {
    if (err) {
      console.error('[DB] Error checking invoices:', err.message);
      return;
    }
    if (row.count > 0) {
      db.run(`
        UPDATE sales
        SET source = 'invoice'
        WHERE id IN (
          SELECT s.id
          FROM sales s
          JOIN invoices i ON s.customer_id = i.customer_id
          AND s.date = i.date
          AND s.total = i.total
        ) AND (source IS NULL OR source != 'invoice')
      `, (err) => {
        if (err) {
          console.error('[DB] Error updating sales source:', err.message);
        } else {
          console.log('[DB] Updated sales source for invoice-converted sales');
        }
      });
    }
  });
  db.run("ALTER TABLE products ADD COLUMN item_kind TEXT DEFAULT 'product'", (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('[DB] Error adding item_kind to products:', err.message);
    } else {
      console.log('[DB] products.item_kind ready');
    }
    db.run("UPDATE products SET item_kind = 'product' WHERE item_kind IS NULL OR item_kind = ''");
    // No sample products are seeded. Use npm run seed:demo for fake data.
  });
  // Add notes column to inventory_transactions
  db.run('ALTER TABLE inventory_transactions ADD COLUMN notes TEXT', (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('[DB] Error adding notes column to inventory_transactions:', err.message);
    } else {
      console.log('[DB] Added notes column to inventory_transactions table');
    }
  });
  // Backfill wholesale_price in item tables to lock historical COGS
  db.run(`
    UPDATE sale_items
    SET wholesale_price = COALESCE((
      SELECT wholesale_price FROM products WHERE products.id = sale_items.product_id
    ), 0)
    WHERE wholesale_price IS NULL
  `, (err) => {
    if (err) {
      console.error('[DB] Error backfilling sale_items wholesale_price:', err.message);
    } else {
      console.log('[DB] Backfilled wholesale_price in sale_items');
    }
  });
  db.run(`
    UPDATE estimate_items
    SET wholesale_price = COALESCE((
      SELECT wholesale_price FROM products WHERE products.id = estimate_items.product_id
    ), 0)
    WHERE wholesale_price IS NULL
  `, (err) => {
    if (err) {
      console.error('[DB] Error backfilling estimate_items wholesale_price:', err.message);
    } else {
      console.log('[DB] Backfilled wholesale_price in estimate_items');
    }
  });
  db.run(`
    UPDATE invoice_items
    SET wholesale_price = COALESCE((
      SELECT wholesale_price FROM products WHERE products.id = invoice_items.product_id
    ), 0)
    WHERE wholesale_price IS NULL
  `, (err) => {
    if (err) {
      console.error('[DB] Error backfilling invoice_items wholesale_price:', err.message);
    } else {
      console.log('[DB] Backfilled wholesale_price in invoice_items');
    }
  });
  db.run(`
    UPDATE estimate_items
    SET wholesale_price = COALESCE((
      SELECT wholesale_price FROM products WHERE products.id = estimate_items.product_id
    ), 0)
    WHERE wholesale_price IS NULL
  `, (err) => {
    if (err) {
      console.error('[DB] Error backfilling estimate_items wholesale_price:', err.message);
    } else {
      console.log('[DB] Backfilled wholesale_price in estimate_items');
    }
  });
  db.run(`
    UPDATE invoice_items
    SET wholesale_price = COALESCE((
      SELECT wholesale_price FROM products WHERE products.id = invoice_items.product_id
    ), 0)
    WHERE wholesale_price IS NULL
  `, (err) => {
    if (err) {
      console.error('[DB] Error backfilling invoice_items wholesale_price:', err.message);
    } else {
      console.log('[DB] Backfilled wholesale_price in invoice_items');
    }
  });
});
// Bills Endpoints
app.get('/api/bills', (req, res) => {
  const companyId = req.query.company_id || 1;
  db.all(
    'SELECT b.*, v.name AS vendor_name, ec.name AS category_name FROM bills b LEFT JOIN vendors v ON b.vendor_id = v.id LEFT JOIN expense_categories ec ON b.expense_category_id = ec.id WHERE b.company_id = ?',
    [companyId],
    (err, bills) => {
      if (err) {
        console.error('[API] Error querying bills:', err.message);
        return res.status(500).json({ error: err.message });
      }
      res.json(bills);
    });
});
app.post('/api/bills', async (req, res) => {
  const { vendor_id, purchase_order_id, invoice_number, amount, bill_date, due_date, is_inventory_bill, expense_category_id, payment_date, company_id = 1 } = req.body;
  if (!vendor_id || amount == null || !bill_date) {
    console.error('[API] POST /api/bills: Missing required fields', { vendor_id, amount, bill_date });
    return res.status(400).json({ error: 'Missing required fields: vendor_id, amount, and bill_date are required' });
  }
  if (!isValidDate(bill_date)) {
    console.error('[API] POST /api/bills: Invalid bill_date format:', bill_date);
    return res.status(400).json({ error: 'Invalid bill_date format: must be YYYY-MM-DD' });
  }
  if (due_date && !isValidDate(due_date)) {
    console.error('[API] POST /api/bills: Invalid due_date format:', due_date);
    return res.status(400).json({ error: 'Invalid due_date format: must be YYYY-MM-DD' });
  }
  if (amount <= 0) {
    console.error('[API] POST /api/bills: Invalid amount:', amount);
    return res.status(400).json({ error: 'Amount must be positive' });
  }
  try {
    const vendor = await new Promise((resolve, reject) => {
      db.get('SELECT id FROM vendors WHERE id = ? AND company_id = ?', [vendor_id, company_id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    if (!vendor) {
      console.error('[API] Invalid vendor_id:', vendor_id);
      return res.status(400).json({ error: 'Invalid vendor_id' });
    }
    if (purchase_order_id) {
      const po = await new Promise((resolve, reject) => {
        db.get('SELECT id FROM purchase_orders WHERE id = ? AND company_id = ?', [purchase_order_id, company_id], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });
      if (!po) {
        console.error('[API] Invalid purchase_order_id:', purchase_order_id);
        return res.status(400).json({ error: 'Invalid purchase_order_id' });
      }
    }
    if (expense_category_id) {
      const category = await new Promise((resolve, reject) => {
        db.get('SELECT id FROM expense_categories WHERE id = ? AND company_id = ?', [expense_category_id, company_id], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });
      if (!category) {
        console.error('[API] Invalid expense_category_id:', expense_category_id);
        return res.status(400).json({ error: 'Invalid expense_category_id' });
      }
    }
    const pdtBillDate = toPDTDate(bill_date);
    const pdtDueDate = due_date ? toPDTDate(due_date) : null;
    const bill_number = `BILL-${Date.now()}`;
    await new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO bills (vendor_id, purchase_order_id, bill_number, invoice_number, amount, bill_date, due_date, is_inventory_bill, expense_category_id, payment_date, company_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [vendor_id, purchase_order_id || null, bill_number, invoice_number || null, amount, pdtBillDate, pdtDueDate, is_inventory_bill ? 1 : 0, expense_category_id || null, payment_date || null, company_id],
        function(err) {
          if (err) {
            console.error('[API] Error inserting bill:', err.message);
            reject(err);
          } else {
            resolve();
          }
        });
    });
    const bill = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM bills WHERE bill_number = ?', [bill_number], (err, row) => {
        if (err) {
          console.error('[API] Error fetching new bill:', err.message);
          reject(err);
        } else {
          resolve(row);
        }
      });
    });
    res.status(201).json({ success: true, bill_number, bill });
  } catch (err) {
    console.error('[API] Error processing bill:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// Helper: Normalize any incoming date string to a reliable YYYY-MM-DD in Pacific local date
function normalizePacificDate(input) {
  let dt;

  // Most common case: <input type="date"> gives us exactly "2026-01-12"
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    // Treat it as midnight in Pacific time (what the user actually selected on their calendar)
    dt = DateTime.fromFormat(input, 'yyyy-MM-dd', { zone: 'America/Los_Angeles' });
  }
  // Fallback for full ISO strings or other formats
  else {
    dt = DateTime.fromISO(input, { zone: 'utc' }).setZone('America/Los_Angeles');
  }

  if (!dt || !dt.isValid) {
    console.warn(`Invalid date input: ${input}`);
    return null;
  }

  // Return just the local YYYY-MM-DD (the calendar day in Pacific time)
  return dt.toFormat('yyyy-MM-dd');
}
app.put('/api/bills/:id', async (req, res) => {
  const {
    vendor_id,
    purchase_order_id,
    bill_number,
    invoice_number,
    amount,
    bill_date,
    due_date,
    is_inventory_bill,
    expense_category_id,
    paid,
    payment_date,
    company_id = 1
  } = req.body;
  console.log(`[API] PUT /api/bills/${req.params.id} called with payload:`, {
    vendor_id, purchase_order_id, bill_number, invoice_number, amount, bill_date,
    due_date, is_inventory_bill, expense_category_id, paid, payment_date, company_id
  });
  if (!vendor_id || amount == null || !bill_date) {
    console.error('[API] Missing required fields:', { vendor_id, amount, bill_date });
    return res.status(400).json({ error: 'Missing required fields: vendor_id, amount, and bill_date are required' });
  }
  if (!isValidDate(bill_date)) {
    console.error('[API] Invalid bill_date format:', bill_date);
    return res.status(400).json({ error: 'Invalid bill_date format: must be YYYY-MM-DD' });
  }
  if (due_date && !isValidDate(due_date)) {
    console.error('[API] Invalid due_date format:', due_date);
    return res.status(400).json({ error: 'Invalid due_date format: must be YYYY-MM-DD' });
  }
  if (payment_date && !isValidDate(payment_date)) {
    console.error('[API] Invalid payment_date format:', payment_date);
    return res.status(400).json({ error: 'Invalid payment_date format: must be YYYY-MM-DD' });
  }
  if (amount <= 0) {
    console.error('[API] Invalid amount:', amount);
    return res.status(400).json({ error: 'Amount must be positive' });
  }
  if (paid && !payment_date) {
    console.error('[API] Missing payment_date for paid bill');
    return res.status(400).json({ error: 'Payment date is required when bill is marked as paid' });
  }
  const pdtBillDate = toPDTDate(bill_date);
  const pdtDueDate = due_date ? toPDTDate(due_date) : null;
  const pdtPaymentDate = payment_date ? toPDTDate(payment_date) : null;
  try {
    const vendor = await new Promise((resolve, reject) => {
      db.get('SELECT id FROM vendors WHERE id = ? AND company_id = ?', [vendor_id, company_id], (err, row) => {
        if (err) reject(new Error(`Database error (vendors): ${err.message}`));
        else resolve(row);
      });
    });
    if (!vendor) {
      console.error('[API] Invalid vendor_id:', vendor_id);
      return res.status(400).json({ error: 'Invalid vendor_id: vendor does not exist' });
    }
    if (purchase_order_id) {
      const po = await new Promise((resolve, reject) => {
        db.get('SELECT id FROM purchase_orders WHERE id = ? AND company_id = ?', [purchase_order_id, company_id], (err, row) => {
          if (err) reject(new Error(`Database error (purchase_orders): ${err.message}`));
          else resolve(row);
        });
      });
      if (!po) {
        console.error('[API] Invalid purchase_order_id:', purchase_order_id);
        return res.status(400).json({ error: 'Invalid purchase_order_id: purchase order does not exist' });
      }
    }
    if (expense_category_id) {
      const category = await new Promise((resolve, reject) => {
        db.get('SELECT id FROM expense_categories WHERE id = ? AND company_id = ?', [expense_category_id, company_id], (err, row) => {
          if (err) reject(new Error(`Database error (expense_categories): ${err.message}`));
          else resolve(row);
        });
      });
      if (!category) {
        console.error('[API] Invalid expense_category_id:', expense_category_id);
        return res.status(400).json({ error: 'Invalid expense_category_id: category does not exist' });
      }
    }
    if (bill_number) {
      const existingBill = await new Promise((resolve, reject) => {
        db.get('SELECT id FROM bills WHERE bill_number = ? AND id != ? AND company_id = ?', [bill_number, req.params.id, company_id], (err, row) => {
          if (err) reject(new Error(`Database error (bill_number check): ${err.message}`));
          else resolve(row);
        });
      });
      if (existingBill) {
        console.error('[API] Duplicate bill_number:', bill_number);
        return res.status(400).json({ error: 'Bill number already exists' });
      }
    }
    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE bills
         SET vendor_id = ?, purchase_order_id = ?, bill_number = ?, invoice_number = ?,
             amount = ?, bill_date = ?, due_date = ?, is_inventory_bill = ?,
             expense_category_id = ?, paid = ?, payment_date = ?, company_id = ?
         WHERE id = ?`,
        [
          vendor_id,
          purchase_order_id || null,
          bill_number || null,
          invoice_number || null,
          amount,
          pdtBillDate,
          pdtDueDate,
          is_inventory_bill ? 1 : 0,
          expense_category_id || null,
          paid ? 1 : 0,
          pdtPaymentDate,
          company_id,
          req.params.id
        ],
        function(err) {
          if (err) {
            console.error('[API] Database error updating bill:', err.message);
            reject(new Error(`Database error: ${err.message}`));
          } else if (this.changes === 0) {
            console.error('[API] Bill not found for id:', req.params.id);
            reject(new Error('Bill not found'));
          } else {
            resolve();
          }
        }
      );
    });
    // Fetch updated bill
    const bill = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM bills WHERE id = ?', [req.params.id], (err, row) => {
        if (err) {
          console.error('[API] Database error fetching bill:', err.message);
          reject(new Error(`Database error: ${err.message}`));
        } else {
          resolve(row);
        }
      });
    });
    console.log(`[API] Successfully updated bill ${req.params.id}`);
    res.json(bill);
  } catch (err) {
    console.error(`[API] PUT /api/bills/${req.params.id} error:`, err.message);
    res.status(err.message === 'Bill not found' ? 404 : 500).json({ error: err.message });
  }
});

// near the other bills endpoints
app.delete('/api/bills/:id', (req, res) => {
  const id = req.params.id;
  const companyId = req.query.company_id || 1;

  db.run(
    'DELETE FROM bills WHERE id = ? AND company_id = ?',
    [id, companyId],
    function (err) {
      if (err) {
        console.error('[DELETE bill]', err.message);
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Bill not found or belongs to different company' });
      }
      res.status(204).send();
    }
  );
});

app.post('/api/purchase-order', async (req, res) => {
  const { po_number, vendor_id, drop_ship_customer_id, date_ordered, expected_delivery, status, created_date, items, notes, company_id = 1, shipping_address } = req.body;
  console.log(`[API] POST /api/purchase-order called with company_id=${company_id}, po_number=${po_number}, items_count=${items?.length || 0}`);
  if (!po_number || !vendor_id || !date_ordered || !status || !items || !Array.isArray(items) || items.length === 0) {
    console.error('[API] POST /api/purchase-order: Missing required fields');
    return res.status(400).json({ error: 'Missing required fields: po_number, vendor_id, date_ordered, status, and items are required' });
  }
  try {
    const vendor = await new Promise((resolve, reject) => {
      db.get('SELECT id FROM vendors WHERE id = ? AND company_id = ?', [vendor_id, company_id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    if (!vendor) {
      console.error('[API] Invalid vendor_id:', vendor_id);
      return res.status(400).json({ error: 'Invalid vendor_id' });
    }
    if (drop_ship_customer_id) {
      const customer = await new Promise((resolve, reject) => {
        db.get('SELECT id FROM customers WHERE id = ? AND company_id = ?', [drop_ship_customer_id, company_id], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });
      if (!customer) {
        console.error('[API] Invalid drop_ship_customer_id:', drop_ship_customer_id);
        return res.status(400).json({ error: 'Invalid drop_ship_customer_id' });
      }
    }
    for (const item of items) {
      if (!item.product_id || !item.quantity || !item.unit_price) {
        console.error('[API] Invalid item:', item);
        return res.status(400).json({ error: 'Each item must have product_id, quantity, and unit_price' });
      }
      const product = await new Promise((resolve, reject) => {
        db.get('SELECT id FROM products WHERE id = ? AND company_id = ?', [item.product_id, company_id], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });
      if (!product) {
        console.error('[API] Invalid product_id:', item.product_id);
        return res.status(400).json({ error: `Invalid product_id: ${item.product_id}` });
      }
    }
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      db.run(
        'INSERT INTO purchase_orders (po_number, vendor_id, drop_ship_customer_id, date_ordered, expected_delivery, status, created_date, notes, shipping_address, company_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [po_number, vendor_id, drop_ship_customer_id || null, date_ordered, expected_delivery || null, status, created_date || new Date().toISOString(), notes || null, shipping_address || null, company_id],
        function(err) {
          if (err) {
            console.error('[API] Error inserting purchase_order:', err.message);
            db.run('ROLLBACK');
            return res.status(500).json({ error: 'Failed to insert purchase order: ' + err.message });
          }
          const poId = this.lastID;
          const insertItem = db.prepare('INSERT INTO purchase_order_items (purchase_order_id, product_id, quantity, unit_price, company_id) VALUES (?, ?, ?, ?, ?)');
          Promise.all(items.map(item => new Promise((resolve, reject) => {
            insertItem.run([poId, item.product_id, item.quantity, item.unit_price, company_id], err => {
              if (err) reject(err);
              else resolve();
            });
          }))).then(() => {
            insertItem.finalize();
            db.run('COMMIT', err => {
              if (err) {
                console.error('[API] Error committing purchase order:', err.message);
                db.run('ROLLBACK');
                return res.status(500).json({ error: 'Failed to commit purchase order: ' + err.message });
              }
              db.get(
                'SELECT po.*, v.name as vendor_name FROM purchase_orders po LEFT JOIN vendors v ON po.vendor_id = v.id WHERE po.id = ? AND po.company_id = ?',
                [poId, company_id],
                (err, po) => {
                  if (err) {
                    console.error('[API] Error fetching new purchase order:', err.message);
                    return res.status(500).json({ error: 'Failed to fetch new purchase order: ' + err.message });
                  }
                  db.all(
                    'SELECT poi.*, p.name as product_name, p.sku FROM purchase_order_items poi LEFT JOIN products p ON poi.product_id = p.id WHERE poi.purchase_order_id = ? AND poi.company_id = ?',
                    [poId, company_id],
                    (err, items) => {
                      if (err) {
                        console.error('[API] Error fetching purchase order items:', err.message);
                        return res.status(500).json({ error: 'Failed to fetch purchase order items: ' + err.message });
                      }
                      po.items = items;
                      console.log(`[API] Successfully created PO ${po_number} with ${items.length} items`);
                      res.status(201).json(po);
                    });
                });
            });
          }).catch(itemErrors => {
            console.error('[API] Error inserting purchase_order_items:', itemErrors);
            db.run('ROLLBACK');
            return res.status(500).json({ error: 'Failed to insert items: ' + itemErrors.message });
          });
        });
    });
  } catch (err) {
    console.error('[API] Error processing purchase order:', err.message);
    res.status(500).json({ error: 'Internal server error: ' + err.message });
  }
});
app.put('/api/purchase-order/:id', async (req, res) => {
  const { id } = req.params;
  const company_id = req.query.company_id || 1;
  const { 
  po_number, vendor_id, drop_ship_customer_id, date_ordered, expected_delivery, 
  status, notes, items, created_date = null 
} = req.body;
  
  console.log(`[API] PUT /api/purchase-order/${req.params.id} called with company_id=${company_id}, po_number=${po_number}`);
  
  if (!po_number || !vendor_id || !date_ordered || !status || !items || !Array.isArray(items) || items.length === 0) {
    console.error('[API] PUT /api/purchase-order: Missing required fields');
    return res.status(400).json({ error: 'Missing required fields: po_number, vendor_id, date_ordered, status, and items are required' });
  }
  
  try {
    const vendor = await new Promise((resolve, reject) => {
      db.get('SELECT id FROM vendors WHERE id = ? AND company_id = ?', [vendor_id, company_id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    if (!vendor) {
      console.error('[API] Invalid vendor_id:', vendor_id);
      return res.status(400).json({ error: 'Invalid vendor_id' });
    }
    if (drop_ship_customer_id) {
      const customer = await new Promise((resolve, reject) => {
        db.get('SELECT id FROM customers WHERE id = ? AND company_id = ?', [drop_ship_customer_id, company_id], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });
      if (!customer) {
        console.error('[API] Invalid drop_ship_customer_id:', drop_ship_customer_id);
        return res.status(400).json({ error: 'Invalid drop_ship_customer_id' });
      }
    }
    for (const item of items) {
      if (!item.product_id || !item.quantity || !item.unit_price) {
        console.error('[API] Invalid item:', item);
        return res.status(400).json({ error: 'Each item must have product_id, quantity, and unit_price' });
      }
      const product = await new Promise((resolve, reject) => {
        db.get('SELECT id FROM products WHERE id = ? AND company_id = ?', [item.product_id, company_id], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });
      if (!product) {
        console.error('[API] Invalid product_id:', item.product_id);
        return res.status(400).json({ error: `Invalid product_id: ${item.product_id}` });
      }
    }
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      db.run(
        'UPDATE purchase_orders SET po_number = ?, vendor_id = ?, drop_ship_customer_id = ?, date_ordered = ?, expected_delivery = ?, status = ?, created_date = ?, notes = ?, company_id = ? WHERE id = ?',
        [po_number, vendor_id, drop_ship_customer_id || null, date_ordered, expected_delivery || null, status, created_date || new Date().toISOString(), notes || null, company_id, id],
        function(err) {
          if (err) {
            console.error('[API] Error updating purchase_order:', err.message);
            db.run('ROLLBACK');
            return res.status(500).json({ error: 'Failed to update purchase order: ' + err.message });
          }
          if (this.changes === 0) {
            console.error('[API] Purchase order not found for id:', id);
            db.run('ROLLBACK');
            return res.status(404).json({ error: 'Purchase order not found' });
          }
          db.run('DELETE FROM purchase_order_items WHERE purchase_order_id = ? AND company_id = ?', [id, company_id], err => {
            if (err) {
              console.error('[API] Error deleting purchase_order_items:', err.message);
              db.run('ROLLBACK');
              return res.status(500).json({ error: 'Failed to delete existing items: ' + err.message });
            }
            const insertItem = db.prepare('INSERT INTO purchase_order_items (purchase_order_id, product_id, quantity, unit_price, company_id) VALUES (?, ?, ?, ?, ?)');
            let itemErrors = [];
            items.forEach(item => {
              insertItem.run([id, item.product_id, item.quantity, item.unit_price, company_id], err => {
                if (err) itemErrors.push(err.message);
              });
            });
            insertItem.finalize();
            if (itemErrors.length > 0) {
              console.error('[API] Error inserting purchase_order_items:', itemErrors.join('; '));
              db.run('ROLLBACK');
              return res.status(500).json({ error: 'Failed to insert items: ' + itemErrors.join('; ') });
            }
            db.run('COMMIT', err => {
              if (err) {
                console.error('[API] Error committing purchase order update:', err.message);
                db.run('ROLLBACK');
                return res.status(500).json({ error: 'Failed to commit purchase order update: ' + err.message });
              }
              db.get(
                'SELECT po.*, v.name as vendor_name FROM purchase_orders po LEFT JOIN vendors v ON po.vendor_id = v.id WHERE po.id = ? AND po.company_id = ?',
                [id, company_id],
                (err, po) => {
                  if (err) {
                    console.error('[API] Error fetching updated purchase order:', err.message);
                    return res.status(500).json({ error: 'Failed to fetch updated purchase order: ' + err.message });
                  }
                  db.all(
                    'SELECT poi.*, p.name as product_name, p.sku FROM purchase_order_items poi LEFT JOIN products p ON poi.product_id = p.id WHERE poi.purchase_order_id = ? AND poi.company_id = ?',
                    [id, company_id],
                    (err, items) => {
                      if (err) {
                        console.error('[API] Error fetching purchase order items:', err.message);
                        return res.status(500).json({ error: 'Failed to fetch purchase order items: ' + err.message });
                      }
                      po.items = items;
                      res.json(po);
                    });
                });
            });
          });
        });
    });
  } catch (err) {
    console.error('[API] Error processing purchase order update:', err.message);
    res.status(500).json({ error: 'Internal server error: ' + err.message });
  }
});
app.delete('/api/purchase-order/:id', (req, res) => {
  const { id } = req.params;
  const companyId = req.query.company_id || 1;
  console.log(`[API] DELETE /api/purchase-order/${id} called with company_id=${companyId}`);
  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    db.run('DELETE FROM purchase_order_items WHERE purchase_order_id = ? AND company_id = ?', [id, companyId], err => {
      if (err) {
        console.error('[API] Error deleting purchase_order_items:', err.message);
        db.run('ROLLBACK');
        return res.status(500).json({ error: 'Failed to delete purchase order items: ' + err.message });
      }
      db.run('DELETE FROM purchase_orders WHERE id = ? AND company_id = ?', [id, companyId], function(err) {
        if (err) {
          console.error('[API] Error deleting purchase_order:', err.message);
          db.run('ROLLBACK');
          return res.status(500).json({ error: 'Failed to delete purchase order: ' + err.message });
        }
        if (this.changes === 0) {
          console.error('[API] Purchase order not found for id:', id);
          db.run('ROLLBACK');
          return res.status(404).json({ error: 'Purchase order not found' });
        }
        db.run('COMMIT', err => {
          if (err) {
            console.error('[API] Error committing purchase order deletion:', err.message);
            db.run('ROLLBACK');
            return res.status(500).json({ error: 'Failed to commit purchase order deletion: ' + err.message });
          }
          res.status(204).send();
        });
      });
    });
  });
});
// Customers Endpoints
app.get('/api/customers', (req, res) => {
  const companyId = req.query.company_id || 1;
  db.all('SELECT * FROM customers WHERE company_id = ?', [companyId], (err, customers) => {
    if (err) {
      console.error('[API] Error querying customers:', err.message);
      return res.status(500).json({ error: err.message });
    }
    res.json(customers);
  });
});
// --- Customer duplicate detect + merge ---
app.get('/api/customers/duplicates', async (req, res) => {
  const companyId = parseInt(req.query.company_id, 10) || 1;
  try {
    const customers = await dbAll(
      'SELECT id, name, email, phone, billing_address, shipping_address, company_id FROM customers WHERE company_id = ?',
      [companyId]
    );
    const groups = { email: [], phone: [], address: [], name: [] };
    const byEmail = new Map();
    const byPhone = new Map();
    const byBill = new Map();
    const byShip = new Map();
    const byName = new Map();

    for (const c of customers) {
      const em = normalizeEmail(c.email);
      if (em) {
        if (!byEmail.has(em)) byEmail.set(em, []);
        byEmail.get(em).push(c);
      }
      const ph = normalizePhone(c.phone);
      if (ph) {
        if (!byPhone.has(ph)) byPhone.set(ph, []);
        byPhone.get(ph).push(c);
      }
      const ba = normalizeAddress(c.billing_address);
      if (ba && ba.length >= 12) {
        if (!byBill.has(ba)) byBill.set(ba, []);
        byBill.get(ba).push(c);
      }
      const sa = normalizeAddress(c.shipping_address);
      if (sa && sa.length >= 12) {
        if (!byShip.has(sa)) byShip.set(sa, []);
        byShip.get(sa).push(c);
      }
      const nm = String(c.name || '').trim().toLowerCase();
      if (nm && nm.length >= 3) {
        if (!byName.has(nm)) byName.set(nm, []);
        byName.get(nm).push(c);
      }
    }

    const pushGroups = (map, matchType, out) => {
      for (const [key, list] of map.entries()) {
        if (list.length < 2) continue;
        // unique by id
        const seen = new Set();
        const uniq = [];
        for (const c of list) {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          uniq.push(c);
        }
        if (uniq.length >= 2) {
          out.push({ match_type: matchType, match_key: key, count: uniq.length, customers: uniq });
        }
      }
    };
    pushGroups(byEmail, 'email', groups.email);
    pushGroups(byPhone, 'phone', groups.phone);
    pushGroups(byBill, 'billing_address', groups.address);
    pushGroups(byShip, 'shipping_address', groups.address);
    pushGroups(byName, 'name', groups.name);

    // Sort largest first
    for (const k of Object.keys(groups)) {
      groups[k].sort((a, b) => b.count - a.count);
    }

    res.json({
      company_id: companyId,
      summary: {
        email_groups: groups.email.length,
        phone_groups: groups.phone.length,
        address_groups: groups.address.length,
        name_groups: groups.name.length
      },
      groups
    });
  } catch (err) {
    console.error('[API] customers/duplicates:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/customers/merge', async (req, res) => {
  const { keep_id, merge_ids, company_id = 1 } = req.body || {};
  const keepId = parseInt(keep_id, 10);
  const companyId = parseInt(company_id, 10) || 1;
  const mergeIds = (Array.isArray(merge_ids) ? merge_ids : [])
    .map((id) => parseInt(id, 10))
    .filter((id) => id && id !== keepId);

  if (!keepId || mergeIds.length === 0) {
    return res.status(400).json({ error: 'keep_id and merge_ids (non-empty, excluding keep) are required' });
  }

  try {
    const keep = await dbGet('SELECT * FROM customers WHERE id = ? AND company_id = ?', [keepId, companyId]);
    if (!keep) return res.status(404).json({ error: 'Keep customer not found' });

    const toMerge = [];
    for (const mid of mergeIds) {
      const row = await dbGet('SELECT * FROM customers WHERE id = ? AND company_id = ?', [mid, companyId]);
      if (!row) return res.status(400).json({ error: `Merge customer ${mid} not found for company` });
      toMerge.push(row);
    }

    // Prefer non-empty fields: keep first, then fill from merged (oldest id first)
    toMerge.sort((a, b) => a.id - b.id);
    let name = keep.name;
    let email = keep.email;
    let phone = keep.phone;
    let billing = keep.billing_address;
    let shipping = keep.shipping_address;
    for (const m of toMerge) {
      if (!email || !String(email).trim()) email = m.email;
      if (!phone || !String(phone).trim()) phone = m.phone;
      if (!billing || !String(billing).trim()) billing = m.billing_address;
      if (!shipping || !String(shipping).trim()) shipping = m.shipping_address;
      if (!name || !String(name).trim()) name = m.name;
    }

    await dbRun('BEGIN IMMEDIATE TRANSACTION');
    try {
      for (const mid of mergeIds) {
        await dbRun('UPDATE sales SET customer_id = ?, customer_name = ? WHERE customer_id = ? AND company_id = ?', [keepId, name, mid, companyId]);
        await dbRun('UPDATE estimates SET customer_id = ?, customer_name = ? WHERE customer_id = ? AND company_id = ?', [keepId, name, mid, companyId]);
        await dbRun('UPDATE invoices SET customer_id = ?, customer_name = ? WHERE customer_id = ? AND company_id = ?', [keepId, name, mid, companyId]);
        await dbRun('UPDATE deposits SET customer_id = ? WHERE customer_id = ? AND company_id = ?', [keepId, mid, companyId]);
        await dbRun('UPDATE packing_slips SET customer_id = ? WHERE customer_id = ? AND company_id = ?', [keepId, mid, companyId]);
        await dbRun(
          'UPDATE purchase_orders SET drop_ship_customer_id = ? WHERE drop_ship_customer_id = ? AND company_id = ?',
          [keepId, mid, companyId]
        );
        await dbRun('DELETE FROM customers WHERE id = ? AND company_id = ?', [mid, companyId]);
      }
      await dbRun(
        `UPDATE customers SET name = ?, email = ?, phone = ?, billing_address = ?, shipping_address = ?
         WHERE id = ? AND company_id = ?`,
        [name, email || null, phone || null, billing || '', shipping || ' ', keepId, companyId]
      );
      await dbRun('COMMIT');
    } catch (txErr) {
      try { await dbRun('ROLLBACK'); } catch (_) { /* ignore */ }
      throw txErr;
    }

    const updated = await dbGet('SELECT * FROM customers WHERE id = ?', [keepId]);
    res.json({
      ok: true,
      kept: updated,
      merged_ids: mergeIds,
      message: `Merged ${mergeIds.length} customer(s) into #${keepId}`
    });
  } catch (err) {
    console.error('[API] customers/merge:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** Resolve effective ship-to for a customer (and optional override) */
app.get('/api/ship-to', async (req, res) => {
  try {
    const companyId = parseInt(req.query.company_id, 10) || 1;
    const customerId = parseInt(req.query.customer_id, 10);
    const saleId = parseInt(req.query.sale_id, 10);
    let saleShipping = null;
    let customer = null;
    if (saleId) {
      const sale = await dbGet('SELECT * FROM sales WHERE id = ? AND company_id = ?', [saleId, companyId]);
      if (sale) {
        saleShipping = sale.shipping_address;
        customer = await dbGet('SELECT * FROM customers WHERE id = ?', [sale.customer_id]);
      }
    }
    if (!customer && customerId) {
      customer = await dbGet('SELECT * FROM customers WHERE id = ? AND company_id = ?', [customerId, companyId]);
    }
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    const address = resolveShipTo({
      override: req.query.override,
      sale_shipping: saleShipping,
      customer_shipping: customer.shipping_address,
      customer_billing: customer.billing_address
    });
    res.json({
      customer_id: customer.id,
      billing_address: customer.billing_address || '',
      shipping_address: customer.shipping_address || '',
      sale_shipping_address: saleShipping || '',
      effective_shipping_address: address
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get('/api/customers/:id', (req, res) => {
  const { id } = req.params;
  const companyId = req.query.company_id || 1;
  db.get(
    'SELECT * FROM customers WHERE id = ? AND company_id = ?',
    [id, companyId],
    (err, customer) => {
      if (err) {
        console.error('[API] Error querying customer:', err.message);
        return res.status(500).json({ error: err.message });
      }
      if (!customer) {
        console.error('[API] Customer not found for id:', id);
        return res.status(404).json({ error: 'Customer not found' });
      }
      res.json(customer);
    });
});
app.post('/api/customers', (req, res) => {
  const { name, email, phone, billing_address, shipping_address, company_id = 1 } = req.body;
  if (!name || !billing_address || !company_id) {
    console.error('[API] POST /api/customers: Missing required fields');
    return res.status(400).json({ error: 'Missing required fields' });
  }
  // If shipping empty/blank, copy billing (drop-ship forms need ship-to)
  const bill = String(billing_address || '').trim();
  const shipRaw = String(shipping_address || '').trim();
  const ship = shipRaw && shipRaw !== ' ' ? shipRaw : bill;
  db.get('SELECT id FROM customers WHERE name = ? AND company_id = ?', [name, company_id], (err, existing) => {
    if (err) {
      console.error('[API] Error checking duplicate customer:', err.message);
      return res.status(500).json({ error: err.message });
    }
    if (existing) {
      console.error('[API] Duplicate customer name:', name);
      return res.status(409).json({ error: 'Customer with this name already exists' });
    }
    db.run(
      'INSERT INTO customers (name, email, phone, billing_address, shipping_address, company_id) VALUES (?, ?, ?, ?, ?, ?)',
      [name, email, phone, bill, ship || bill, company_id],
      function(err) {
        if (err) {
          console.error('[API] Error inserting customer:', err.message);
          return res.status(500).json({ error: err.message });
        }
        db.get('SELECT * FROM customers WHERE id = ?', [this.lastID], (err, customer) => {
          if (err) {
            console.error('[API] Error fetching new customer:', err.message);
            return res.status(500).json({ error: err.message });
          }
          res.status(201).json(customer);
        });
      });
  });
});
app.post('/api/customers/import', (req, res) => {
  const customers = req.body;
  if (!Array.isArray(customers) || customers.length === 0) {
    console.error('[API] POST /api/customers/import: Invalid or empty customer data');
    return res.status(400).json({ error: 'Invalid or empty customer data' });
  }
  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    const insert = db.prepare('INSERT INTO customers (name, email, phone, billing_address, shipping_address, company_id) VALUES (?, ?, ?, ?, ?, ?)');
    const inserted = [];
    const errors = [];
    customers.forEach(customer => {
      if (!customer.name || !customer.billing_address || !customer.company_id) {
        errors.push('Missing required fields for customer: ' + JSON.stringify(customer));
        return;
      }
      const bill = String(customer.billing_address || '').trim();
      const shipRaw = String(customer.shipping_address || '').trim();
      const ship = shipRaw && shipRaw !== ' ' ? shipRaw : bill;
      insert.run(
        [customer.name, customer.email || null, customer.phone || null, bill, ship || bill, customer.company_id],
        function(err) {
          if (err) {
            errors.push('Error inserting customer ' + customer.name + ': ' + err.message);
          } else {
            db.get('SELECT * FROM customers WHERE id = ?', [this.lastID], (err, insertedCustomer) => {
              if (!err) inserted.push(insertedCustomer);
            });
          }
        });
    });
    insert.finalize();
    db.run('COMMIT', err => {
      if (err) {
        console.error('[API] Error committing customer import:', err.message);
        db.run('ROLLBACK');
        return res.status(500).json({ error: err.message });
      }
      res.status(201).json({ inserted, errors });
    });
  });
});
app.put('/api/customers/:id', (req, res) => {
  // ← Add these two lines right here
  console.log('[PUT /api/customers/:id] Received body:', req.body);
  console.log('[PUT /api/customers/:id] Params:', req.params);
  const { name, email, phone, billing_address, shipping_address, company_id } = req.body;
  if (!name || !billing_address || !company_id) {
    console.error('[API] PUT /api/customers/:id: Missing required fields');
    return res.status(400).json({ error: 'Missing required fields' });
  }
  db.run(
    'UPDATE customers SET name = ?, email = ?, phone = ?, billing_address = ?, shipping_address = ?, company_id = ? WHERE id = ?',
    [name, email, phone, billing_address, shipping_address, company_id, req.params.id],
    function(err) {
      if (err) {
        console.error('[API] Error updating customer:', err.message);
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) {
        console.error('[API] Customer not found for id:', req.params.id);
        return res.status(404).json({ error: 'Customer not found' });
      }
      db.get('SELECT * FROM customers WHERE id = ?', [req.params.id], (err, customer) => {
        if (err) {
          console.error('[API] Error fetching updated customer:', err.message);
          return res.status(500).json({ error: err.message });
        }
        res.json(customer);
      });
    });
});
app.delete('/api/customers/:id', (req, res) => {
  const companyId = req.query.company_id || 1;
  db.run(
    'DELETE FROM customers WHERE id = ? AND company_id = ?',
    [req.params.id, companyId],
    function(err) {
      if (err) {
        console.error('[API] Error deleting customer:', err.message);
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) {
        console.error('[API] Customer not found for id:', req.params.id);
        return res.status(404).json({ error: 'Customer not found' });
      }
      res.status(204).send();
    });
});
// Products Endpoints
app.get('/api/products', (req, res) => {
  const companyId = req.query.company_id || 1;
  db.all('SELECT * FROM products WHERE company_id = ?', [companyId], (err, products) => {
    if (err) {
      console.error('[API] Error querying products:', err.message);
      return res.status(500).json({ error: err.message });
    }
    res.json(products);
  });
});
app.get('/api/products/:id', (req, res) => {
  const { id } = req.params;
  const companyId = req.query.company_id || 1;
  db.get(
    'SELECT * FROM products WHERE id = ? AND company_id = ?',
    [id, companyId],
    (err, product) => {
      if (err) {
        console.error('[API] Error querying product:', err.message);
        return res.status(500).json({ error: err.message });
      }
      if (!product) {
        console.error('[API] Product not found for id:', id);
        return res.status(404).json({ error: 'Product not found' });
      }
      res.json(product);
    });
});
app.post('/api/products', (req, res) => {
  const { sku, name, wholesale_price, retail_price, stock, vendor_id, company_id = 1, item_kind, description } = req.body;
  if (!sku || !name || retail_price === undefined || retail_price === '' || retail_price === null || !company_id) {
    console.error('[API] POST /api/products: Missing required fields');
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const kind = String(item_kind || 'product').toLowerCase() === 'service' ? 'service' : 'product';
  db.run(
    'INSERT INTO products (sku, name, wholesale_price, retail_price, stock, vendor_id, company_id, item_kind, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [sku, name, wholesale_price, retail_price, kind === 'service' ? null : stock, vendor_id, company_id, kind, description || null],
    function(err) {
      if (err) {
        console.error('[API] Error inserting product:', err.message);
        return res.status(500).json({ error: err.message });
      }
      db.get('SELECT * FROM products WHERE id = ?', [this.lastID], (err, product) => {
        if (err) {
          console.error('[API] Error fetching new product:', err.message);
          return res.status(500).json({ error: err.message });
        }
        res.status(201).json(product);
      });
    });
});
app.put('/api/products/:id', (req, res) => {
  const { sku, name, wholesale_price, retail_price, stock, vendor_id, company_id, item_kind, description } = req.body;
  if (!sku || !name || retail_price === undefined || retail_price === '' || retail_price === null || !company_id) {
    console.error('[API] PUT /api/products/:id: Missing required fields');
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const kind = String(item_kind || 'product').toLowerCase() === 'service' ? 'service' : 'product';
  db.run(
    'UPDATE products SET sku = ?, name = ?, wholesale_price = ?, retail_price = ?, stock = ?, vendor_id = ?, company_id = ?, item_kind = ?, description = ? WHERE id = ?',
    [sku, name, wholesale_price, retail_price, kind === 'service' ? null : stock, vendor_id, company_id, kind, description || null, req.params.id],
    function(err) {
      if (err) {
        console.error('[API] Error updating product:', err.message);
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) {
        console.error('[API] Product not found for id:', req.params.id);
        return res.status(404).json({ error: 'Product not found' });
      }
      db.get('SELECT * FROM products WHERE id = ?', [req.params.id], (err, product) => {
        if (err) {
          console.error('[API] Error fetching updated product:', err.message);
          return res.status(500).json({ error: err.message });
        }
        res.json(product);
      });
    });
});
app.delete('/api/products/:id', (req, res) => {
  const companyId = req.query.company_id || 1;
  db.run(
    'DELETE FROM products WHERE id = ? AND company_id = ?',
    [req.params.id, companyId],
    function(err) {
      if (err) {
        console.error('[API] Error deleting product:', err.message);
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) {
        console.error('[API] Product not found for id:', req.params.id);
        return res.status(404).json({ error: 'Product not found' });
      }
      res.status(204).send();
    });
});
// Vendors Endpoints
app.get('/api/vendors', (req, res) => {
  const companyId = req.query.company_id || 1;
  db.all('SELECT * FROM vendors WHERE company_id = ?', [companyId], (err, vendors) => {
    if (err) {
      console.error('[API] Error querying vendors:', err.message);
      return res.status(500).json({ error: err.message });
    }
    res.json(vendors);
  });
});
app.get('/api/vendors/:id', (req, res) => {
  const { id } = req.params;
  const companyId = req.query.company_id || 1;
  db.get(
    'SELECT * FROM vendors WHERE id = ? AND company_id = ?',
    [id, companyId],
    (err, vendor) => {
      if (err) {
        console.error('[API] Error querying vendor:', err.message);
        return res.status(500).json({ error: err.message });
      }
      if (!vendor) {
        console.error('[API] Vendor not found for id:', id);
        return res.status(404).json({ error: 'Vendor not found' });
      }
      res.json(vendor);
    });
});
app.post('/api/vendors', (req, res) => {
  const { name, contact_name, email, phone, address, company_id = 1 } = req.body;
  if (!name || !company_id) {
    console.error('[API] POST /api/vendors: Missing required fields');
    return res.status(400).json({ error: 'Missing required fields' });
  }
  db.run(
    'INSERT INTO vendors (name, contact_name, email, phone, address, company_id) VALUES (?, ?, ?, ?, ?, ?)',
    [name, contact_name, email, phone, address, company_id],
    function(err) {
      if (err) {
        console.error('[API] Error inserting vendor:', err.message);
        return res.status(500).json({ error: err.message });
      }
      db.get('SELECT * FROM vendors WHERE id = ?', [this.lastID], (err, vendor) => {
        if (err) {
          console.error('[API] Error fetching new vendor:', err.message);
          return res.status(500).json({ error: err.message });
        }
        res.status(201).json(vendor);
      });
    });
});
app.put('/api/vendors/:id', (req, res) => {
  const { name, contact_name, email, phone, address, company_id } = req.body;
  if (!name || !company_id) {
    console.error('[API] PUT /api/vendors/:id: Missing required fields');
    return res.status(400).json({ error: 'Missing required fields' });
  }
  db.run(
    'UPDATE vendors SET name = ?, contact_name = ?, email = ?, phone = ?, address = ?, company_id = ? WHERE id = ?',
    [name, contact_name, email, phone, address, company_id, req.params.id],
    function(err) {
      if (err) {
        console.error('[API] Error updating vendor:', err.message);
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) {
        console.error('[API] Vendor not found for id:', req.params.id);
        return res.status(404).json({ error: 'Vendor not found' });
      }
      db.get('SELECT * FROM vendors WHERE id = ?', [req.params.id], (err, vendor) => {
        if (err) {
          console.error('[API] Error fetching updated vendor:', err.message);
          return res.status(500).json({ error: err.message });
        }
        res.json(vendor);
      });
    });
});
app.delete('/api/vendors/:id', (req, res) => {
  const companyId = req.query.company_id || 1;
  db.run(
    'DELETE FROM vendors WHERE id = ? AND company_id = ?',
    [req.params.id, companyId],
    function(err) {
      if (err) {
        console.error('[API] Error deleting vendor:', err.message);
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) {
        console.error('[API] Vendor not found for id:', req.params.id);
        return res.status(404).json({ error: 'Vendor not found' });
      }
      res.status(204).send();
    });
});
// Sales Endpoints
app.get('/api/sales', (req, res) => {
  const companyId = req.query.company_id || 1;

  // 5-second timeout — prevents hanging forever
  const timeout = setTimeout(() => {
    console.error('[API] /api/sales TIMEOUT after 5s');
    res.status(504).json({ error: 'Database timeout' });
  }, 5000);

  db.all(
    `SELECT s.*, c.name as customer_name 
     FROM sales s 
     LEFT JOIN customers c ON s.customer_id = c.id 
     WHERE s.company_id = ? 
     ORDER BY s.date DESC`,
    [companyId],
    (err, sales) => {
      clearTimeout(timeout); // cancel timeout if query finished
      if (err) {
        console.error('[API] /api/sales error:', err.message);
        return res.status(500).json({ error: err.message });
      }

      // Now get items
      db.all(
        `SELECT si.*, p.name as product_name, p.sku, 
                p.wholesale_price as current_wholesale_price, p.retail_price 
         FROM sale_items si 
         LEFT JOIN products p ON si.product_id = p.id 
         WHERE si.company_id = ?`,
        [companyId],
        (err, items) => {
          clearTimeout(timeout);
          if (err) {
            console.error('[API] /api/sales sale_items error:', err.message);
            return res.status(500).json({ error: err.message });
          }

          // Attach items to sales
          sales.forEach(sale => {
            sale.items = items
              .filter(item => item.transaction_id === sale.id)
              .map(item => ({
                ...item,
                cogs: item.quantity * (item.wholesale_price || 0)
              }));
          });

          res.json(sales || []);
        }
      );
    }
  );
});
app.get('/api/sales/:id', (req, res) => {
  const { id } = req.params;
  const companyId = req.query.company_id || 1;
  db.get(
    'SELECT s.*, c.name as customer_name FROM sales s LEFT JOIN customers c ON s.customer_id = c.id WHERE s.id = ? AND s.company_id = ?',
    [id, companyId],
    (err, sale) => {
      if (err) {
        console.error('[API] Error querying sale:', err.message);
        return res.status(500).json({ error: err.message });
      }
      if (!sale) {
        console.error('[API] Sale not found for id:', id);
        return res.status(404).json({ error: 'Sale not found' });
      }
      db.all(
        'SELECT si.*, p.name as product_name, p.sku, p.wholesale_price as current_wholesale_price, p.retail_price FROM sale_items si LEFT JOIN products p ON si.product_id = p.id WHERE si.transaction_id = ? AND si.company_id = ?',
        [id, companyId],
        (err, items) => {
          if (err) {
            console.error('[API] Error querying sale_items:', err.message);
            return res.status(500).json({ error: err.message });
          }
          sale.items = items.map(item => ({
            ...item,
            cogs: item.quantity * (item.wholesale_price || 0)  // Always use stored, no fallback to current
          }));
          res.json(sale);
        });
    });
});
app.post('/api/sales', async (req, res) => {
  const { customer_id, items, discount, tax_rate, shipping, payment_method, date, subtotal, tax, total, notes, shipping_address, company_id = 1 } = req.body;
  if (!customer_id || !items || !Array.isArray(items) || items.length === 0 || !payment_method || !date || !company_id) {
    console.error('[API] POST /api/sales: Missing required fields');
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    const cust = await dbGet('SELECT * FROM customers WHERE id = ? AND company_id = ?', [customer_id, company_id]);
    if (!cust) return res.status(400).json({ error: 'Customer not found' });

    const itemsWithWholesale = [];
    for (const item of items) {
      if (!item.product_id || !item.quantity) {
        throw new Error('Invalid item: ' + JSON.stringify(item));
      }
      const product = await dbGet(
        'SELECT id, wholesale_price FROM products WHERE id = ? AND company_id = ?',
        [item.product_id, company_id]
      );
      if (!product) throw new Error(`Product not found for id: ${item.product_id}`);
      itemsWithWholesale.push({
        ...item,
        quantity: parseInt(item.quantity, 10) || 0,
        wholesale_price: product.wholesale_price || 0
      });
    }

    const saleShipAddr = resolveShipTo({
      override: shipping_address,
      customer_shipping: cust.shipping_address,
      customer_billing: cust.billing_address
    }) || null;

    await dbRun('BEGIN IMMEDIATE TRANSACTION');
    let saleId;
    try {
      const txn = generateTransactionNumber(date);
      const ins = await dbRun(
        `INSERT INTO sales (
          customer_id, date, subtotal, tax, tax_rate, shipping, discount, total,
          payment_method, transaction_number, notes, company_id, customer_name, shipping_address
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          customer_id, date, subtotal, tax, tax_rate, shipping, discount, total,
          payment_method, txn, notes || 'Thank you for your patronage!', company_id,
          cust.name, saleShipAddr
        ]
      );
      saleId = ins.lastID;
      for (const item of itemsWithWholesale) {
        await dbRun(
          `INSERT INTO sale_items (transaction_id, product_id, quantity, custom_price, wholesale_price, company_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [saleId, item.product_id, item.quantity, item.custom_price, item.wholesale_price, company_id]
        );
      }
      await applySaleStockDeltas(
        itemsWithWholesale,
        company_id,
        -1,
        date,
        `Sale #${txn} id=${saleId}`
      );
      await dbRun('COMMIT');
    } catch (txErr) {
      try { await dbRun('ROLLBACK'); } catch (_) { /* ignore */ }
      throw txErr;
    }

    const sale = await dbGet(
      'SELECT s.*, c.name as customer_name FROM sales s LEFT JOIN customers c ON s.customer_id = c.id WHERE s.id = ?',
      [saleId]
    );
    sale.items = await dbAll('SELECT * FROM sale_items WHERE transaction_id = ?', [saleId]);
    sale.effective_shipping_address = resolveShipTo({
      sale_shipping: sale.shipping_address,
      customer_shipping: cust.shipping_address,
      customer_billing: cust.billing_address
    });
    res.status(201).json(sale);
  } catch (err) {
    console.error('[API] Error processing sale:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/sales/:id', async (req, res) => {
  const { customer_id, items, discount, tax_rate, shipping, payment_method, date, subtotal, tax, total, shipping_address, company_id } = req.body;
  const saleId = parseInt(req.params.id, 10);
  if (!customer_id || !items || !Array.isArray(items) || items.length === 0 || !payment_method || !date || !company_id || !saleId) {
    console.error('[API] PUT /api/sales: Missing required fields');
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    const existing = await dbGet('SELECT * FROM sales WHERE id = ? AND company_id = ?', [saleId, company_id]);
    if (!existing) return res.status(404).json({ error: 'Sale not found' });

    const cust = await dbGet('SELECT * FROM customers WHERE id = ? AND company_id = ?', [customer_id, company_id]);
    if (!cust) return res.status(400).json({ error: 'Customer not found' });

    const oldItems = await dbAll(
      'SELECT product_id, quantity FROM sale_items WHERE transaction_id = ? AND company_id = ?',
      [saleId, company_id]
    );

    const itemsWithWholesale = [];
    for (const item of items) {
      if (!item.product_id || !item.quantity) {
        throw new Error('Invalid item: ' + JSON.stringify(item));
      }
      const product = await dbGet(
        'SELECT id, wholesale_price FROM products WHERE id = ? AND company_id = ?',
        [item.product_id, company_id]
      );
      if (!product) throw new Error(`Product not found for id: ${item.product_id}`);
      itemsWithWholesale.push({
        ...item,
        quantity: parseInt(item.quantity, 10) || 0,
        wholesale_price: product.wholesale_price || 0
      });
    }

    const saleShipAddr = resolveShipTo({
      override: shipping_address,
      customer_shipping: cust.shipping_address,
      customer_billing: cust.billing_address
    }) || null;

    await dbRun('BEGIN IMMEDIATE TRANSACTION');
    try {
      // Restore stock from previous lines, then apply new lines
      await applySaleStockDeltas(oldItems, company_id, +1, date, `Sale edit restore id=${saleId}`);
      const upd = await dbRun(
        `UPDATE sales SET customer_id = ?, date = ?, subtotal = ?, tax = ?, tax_rate = ?, shipping = ?,
          discount = ?, total = ?, payment_method = ?, company_id = ?, customer_name = ?, shipping_address = ?
         WHERE id = ?`,
        [
          customer_id, date, subtotal, tax, tax_rate, shipping, discount, total,
          payment_method, company_id, cust.name, saleShipAddr, saleId
        ]
      );
      if (!upd.changes) throw new Error('Sale not found on update');
      await dbRun('DELETE FROM sale_items WHERE transaction_id = ? AND company_id = ?', [saleId, company_id]);
      for (const item of itemsWithWholesale) {
        await dbRun(
          `INSERT INTO sale_items (transaction_id, product_id, quantity, custom_price, wholesale_price, company_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [saleId, item.product_id, item.quantity, item.custom_price, item.wholesale_price, company_id]
        );
      }
      await applySaleStockDeltas(
        itemsWithWholesale,
        company_id,
        -1,
        date,
        `Sale edit apply id=${saleId}`
      );
      await dbRun('COMMIT');
    } catch (txErr) {
      try { await dbRun('ROLLBACK'); } catch (_) { /* ignore */ }
      throw txErr;
    }

    const sale = await dbGet(
      'SELECT s.*, c.name as customer_name FROM sales s LEFT JOIN customers c ON s.customer_id = c.id WHERE s.id = ?',
      [saleId]
    );
    sale.items = await dbAll('SELECT * FROM sale_items WHERE transaction_id = ?', [saleId]);
    sale.effective_shipping_address = resolveShipTo({
      sale_shipping: sale.shipping_address,
      customer_shipping: cust.shipping_address,
      customer_billing: cust.billing_address
    });
    res.json(sale);
  } catch (err) {
    console.error('[API] Error processing sale update:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/sales/:id', async (req, res) => {
  const companyId = parseInt(req.query.company_id, 10) || 1;
  const saleId = parseInt(req.params.id, 10);
  console.log(`[API] DELETE /api/sales/${saleId} called with company_id=${companyId}`);
  try {
    const existing = await dbGet('SELECT * FROM sales WHERE id = ? AND company_id = ?', [saleId, companyId]);
    if (!existing) return res.status(404).json({ error: 'Sale not found' });
    const oldItems = await dbAll(
      'SELECT product_id, quantity FROM sale_items WHERE transaction_id = ? AND company_id = ?',
      [saleId, companyId]
    );
    await dbRun('BEGIN IMMEDIATE TRANSACTION');
    try {
      await applySaleStockDeltas(
        oldItems,
        companyId,
        +1,
        existing.date,
        `Sale delete restore id=${saleId}`
      );
      await dbRun('DELETE FROM sale_items WHERE transaction_id = ? AND company_id = ?', [saleId, companyId]);
      await dbRun('DELETE FROM sales WHERE id = ? AND company_id = ?', [saleId, companyId]);
      await dbRun('COMMIT');
    } catch (txErr) {
      try { await dbRun('ROLLBACK'); } catch (_) { /* ignore */ }
      throw txErr;
    }
    res.status(204).send();
  } catch (err) {
    console.error('[API] Error deleting sale:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Estimates Endpoints
app.get('/api/estimates', (req, res) => {
  const companyId = req.query.company_id || 1;
  console.log(`[API] GET /api/estimates called with company_id=${companyId}`);
  db.all(
    'SELECT e.*, c.name as customer_name FROM estimates e LEFT JOIN customers c ON e.customer_id = c.id WHERE e.company_id = ?',
    [companyId],
    (err, estimates) => {
      if (err) {
        console.error('[API] Error querying estimates:', err.message);
        return res.status(500).json({ error: err.message });
      }
      db.all(
        'SELECT ei.*, p.name as product_name, p.sku, p.wholesale_price as current_wholesale_price, p.retail_price FROM estimate_items ei LEFT JOIN products p ON ei.product_id = p.id WHERE ei.company_id = ?',
        [companyId],
        (err, items) => {
          if (err) {
            console.error('[API] Error querying estimate_items:', err.message);
            return res.status(500).json({ error: err.message });
          }
          estimates.forEach(estimate => {
            estimate.items = items.filter(item => item.transaction_id === estimate.id).map(item => ({
              ...item,
              cogs: item.quantity * (item.wholesale_price || 0)  // Always use stored, no fallback to current
            }));
          });
          res.json(estimates);
        });
    });
});
app.get('/api/estimates/:id', (req, res) => {
  const { id } = req.params;
  const companyId = req.query.company_id || 1;
  console.log(`[API] GET /api/estimates/${id} called with company_id=${companyId}`);
  db.get(
    'SELECT e.*, c.name as customer_name FROM estimates e LEFT JOIN customers c ON e.customer_id = c.id WHERE e.id = ? AND e.company_id = ?',
    [id, companyId],
    (err, estimate) => {
      if (err) {
        console.error('[API] Error querying estimate:', err.message);
        return res.status(500).json({ error: err.message });
      }
      if (!estimate) {
        console.error('[API] Estimate not found for id:', id);
        return res.status(404).json({ error: 'Estimate not found' });
      }
      db.all(
        'SELECT ei.*, p.name as product_name, p.sku, p.wholesale_price as current_wholesale_price, p.retail_price FROM estimate_items ei LEFT JOIN products p ON ei.product_id = p.id WHERE ei.transaction_id = ? AND ei.company_id = ?',
        [id, companyId],
        (err, items) => {
          if (err) {
            console.error('[API] Error querying estimate_items:', err.message);
            return res.status(500).json({ error: err.message });
          }
          estimate.items = items.map(item => ({
            ...item,
            cogs: item.quantity * (item.wholesale_price || 0)  // Always use stored, no fallback to current
          }));
          res.json(estimate);
        });
    });
});
app.post('/api/estimates', async (req, res) => {
  const { customer_id, items, discount, tax_rate, shipping, payment_method, date, subtotal, tax, total, notes, status, shipping_address, company_id = 1 } = req.body;
  console.log(`[API] POST /api/estimates called with company_id=${company_id}, items_count=${items?.length || 0}`);
  if (!customer_id || !items || !Array.isArray(items) || items.length === 0 || !payment_method || !date || !status || !company_id) {
    console.error('[API] POST /api/estimates: Missing required fields');
    return res.status(400).json({ error: 'Missing required fields: customer_id, items, payment_method, date, status, and company_id are required' });
  }
  if (!['Pending', 'Approved'].includes(status)) {
    console.error('[API] POST /api/estimates: Invalid status:', status);
    return res.status(400).json({ error: 'Invalid status: must be Pending or Approved' });
  }
  try {
    const itemsWithWholesale = await Promise.all(items.map(async item => {
      if (!item.product_id || !item.quantity) {
        throw new Error('Invalid item: ' + JSON.stringify(item));
      }
      const product = await new Promise((resolve, reject) => {
        db.get('SELECT wholesale_price FROM products WHERE id = ? AND company_id = ?', [item.product_id, company_id], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });
      if (!product) {
        throw new Error(`Product not found for id: ${item.product_id}`);
      }
      return {
        ...item,
        wholesale_price: product.wholesale_price || 0  // Force 0 if null
      };
    }));
    const custRow = await dbGet('SELECT shipping_address, billing_address FROM customers WHERE id = ? AND company_id = ?', [customer_id, company_id]);
    const estShip = resolveShipTo({
      override: shipping_address,
      customer_shipping: custRow && custRow.shipping_address,
      customer_billing: custRow && custRow.billing_address
    }) || null;
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      db.run(
        'INSERT INTO estimates (customer_id, date, subtotal, tax, tax_rate, shipping, discount, total, payment_method, estimate_number, notes, company_id, customer_name, status, shipping_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT name FROM customers WHERE id = ?), ?, ?)',
        [customer_id, date, subtotal, tax, tax_rate, shipping, discount, total, payment_method, generateTransactionNumber(date), notes || 'Estimate for your review', company_id, customer_id, status, estShip],
        function(err) {
          if (err) {
            console.error('[API] Error inserting estimate:', err.message);
            db.run('ROLLBACK');
            return res.status(500).json({ error: err.message });
          }
          const estimateId = this.lastID;
          const insertItem = db.prepare('INSERT INTO estimate_items (transaction_id, product_id, quantity, custom_price, wholesale_price, company_id) VALUES (?, ?, ?, ?, ?, ?)');
          let itemErrors = [];
          itemsWithWholesale.forEach(item => {
            insertItem.run([estimateId, item.product_id, item.quantity, item.custom_price, item.wholesale_price, company_id], err => {
              if (err) itemErrors.push(err.message);
            });
          });
          insertItem.finalize();
          if (itemErrors.length > 0) {
            console.error('[API] Error inserting estimate_items:', itemErrors.join('; '));
            db.run('ROLLBACK');
            return res.status(500).json({ error: 'Failed to insert items: ' + itemErrors.join('; ') });
          }
          db.run('COMMIT', err => {
            if (err) {
              console.error('[API] Error committing estimate:', err.message);
              db.run('ROLLBACK');
              return res.status(500).json({ error: err.message });
            }
            db.get(
              'SELECT e.*, c.name as customer_name FROM estimates e LEFT JOIN customers c ON e.customer_id = c.id WHERE e.id = ?',
              [estimateId],
              (err, estimate) => {
                if (err) {
                  console.error('[API] Error fetching new estimate:', err.message);
                  return res.status(500).json({ error: err.message });
                }
                db.all('SELECT * FROM estimate_items WHERE transaction_id = ?', [estimateId], (err, items) => {
                  if (err) {
                    console.error('[API] Error fetching estimate_items:', err.message);
                    return res.status(500).json({ error: err.message });
                  }
                  estimate.items = items;
                  res.status(201).json(estimate);
                });
              });
          });
        });
    });
  } catch (err) {
    console.error('[API] Error processing estimate:', err.message);
    res.status(500).json({ error: err.message });
  }
});
app.put('/api/estimates/:id', async (req, res) => {
  const { customer_id, items, discount, tax_rate, shipping, payment_method, date, subtotal, tax, total, status, shipping_address, company_id = 1 } = req.body;
  console.log(`[API] PUT /api/estimates/${req.params.id} called with company_id=${company_id}`);
  if (!customer_id || !items || !Array.isArray(items) || items.length === 0 || !payment_method || !date || !status || !company_id) {
    console.error('[API] PUT /api/estimates: Missing required fields');
    return res.status(400).json({ error: 'Missing required fields: customer_id, items, payment_method, date, status, and company_id are required' });
  }
  if (!['Pending', 'Approved', 'Converted'].includes(status)) {
    console.error('[API] PUT /api/estimates: Invalid status:', status);
    return res.status(400).json({ error: 'Invalid status: must be Pending, Approved, or Converted' });
  }
  try {
    const itemsWithWholesale = await Promise.all(items.map(async item => {
      if (!item.product_id || !item.quantity) {
        throw new Error('Invalid item: ' + JSON.stringify(item));
      }
      const product = await new Promise((resolve, reject) => {
        db.get('SELECT wholesale_price FROM products WHERE id = ? AND company_id = ?', [item.product_id, company_id], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });
      if (!product) {
        throw new Error(`Product not found for id: ${item.product_id}`);
      }
      return {
        ...item,
        wholesale_price: product.wholesale_price || 0  // Force 0 if null
      };
    }));
    const custRow = await dbGet('SELECT shipping_address, billing_address FROM customers WHERE id = ? AND company_id = ?', [customer_id, company_id]);
    const estShip = resolveShipTo({
      override: shipping_address,
      customer_shipping: custRow && custRow.shipping_address,
      customer_billing: custRow && custRow.billing_address
    }) || null;
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      db.run(
        'UPDATE estimates SET customer_id = ?, date = ?, subtotal = ?, tax = ?, tax_rate = ?, shipping = ?, discount = ?, total = ?, payment_method = ?, company_id = ?, customer_name = (SELECT name FROM customers WHERE id = ?), status = ?, shipping_address = ? WHERE id = ?',
        [customer_id, date, subtotal, tax, tax_rate, shipping, discount, total, payment_method, company_id, customer_id, status, estShip, req.params.id],
        function(err) {
          if (err) {
            console.error('[API] Error updating estimate:', err.message);
            db.run('ROLLBACK');
            return res.status(500).json({ error: err.message });
          }
          if (this.changes === 0) {
            console.error('[API] Estimate not found for id:', req.params.id);
            db.run('ROLLBACK');
            return res.status(404).json({ error: 'Estimate not found' });
          }
          db.run('DELETE FROM estimate_items WHERE transaction_id = ? AND company_id = ?', [req.params.id, company_id], err => {
            if (err) {
              console.error('[API] Error deleting estimate_items:', err.message);
              db.run('ROLLBACK');
              return res.status(500).json({ error: err.message });
            }
            const insertItem = db.prepare('INSERT INTO estimate_items (transaction_id, product_id, quantity, custom_price, wholesale_price, company_id) VALUES (?, ?, ?, ?, ?, ?)');
            let itemErrors = [];
            itemsWithWholesale.forEach(item => {
              insertItem.run([req.params.id, item.product_id, item.quantity, item.custom_price, item.wholesale_price, company_id], err => {
                if (err) itemErrors.push(err.message);
              });
            });
            insertItem.finalize();
            if (itemErrors.length > 0) {
              console.error('[API] Error inserting estimate_items:', itemErrors.join('; '));
              db.run('ROLLBACK');
              return res.status(500).json({ error: 'Failed to insert items: ' + itemErrors.join('; ') });
            }
            db.run('COMMIT', err => {
              if (err) {
                console.error('[API] Error committing estimate update:', err.message);
                db.run('ROLLBACK');
                return res.status(500).json({ error: err.message });
              }
              db.get(
                'SELECT e.*, c.name as customer_name FROM estimates e LEFT JOIN customers c ON e.customer_id = c.id WHERE e.id = ?',
                [req.params.id],
                (err, estimate) => {
                  if (err) {
                    console.error('[API] Error fetching updated estimate:', err.message);
                    return res.status(500).json({ error: err.message });
                  }
                  db.all('SELECT * FROM estimate_items WHERE transaction_id = ?', [req.params.id], (err, items) => {
                    if (err) {
                      console.error('[API] Error fetching estimate_items:', err.message);
                      return res.status(500).json({ error: err.message });
                    }
                    estimate.items = items;
                    res.json(estimate);
                  });
                });
            });
          });
        });
    });
  } catch (err) {
    console.error('[API] Error processing estimate update:', err.message);
    res.status(500).json({ error: err.message });
  }
});
app.delete('/api/estimates/:id', (req, res) => {
  const companyId = req.query.company_id || 1;
  console.log(`[API] DELETE /api/estimates/${req.params.id} called with company_id=${companyId}`);
  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    db.run('DELETE FROM estimate_items WHERE transaction_id = ? AND company_id = ?', [req.params.id, companyId], err => {
      if (err) {
        console.error('[API] Error deleting estimate_items:', err.message);
        db.run('ROLLBACK');
        return res.status(500).json({ error: err.message });
      }
      db.run('DELETE FROM estimates WHERE id = ? AND company_id = ?', [req.params.id, companyId], function(err) {
        if (err) {
          console.error('[API] Error deleting estimate:', err.message);
          db.run('ROLLBACK');
          return res.status(500).json({ error: err.message });
        }
        if (this.changes === 0) {
          console.error('[API] Estimate not found for id:', req.params.id);
          db.run('ROLLBACK');
          return res.status(404).json({ error: 'Estimate not found' });
        }
        db.run('COMMIT', err => {
          if (err) {
            console.error('[API] Error committing estimate deletion:', err.message);
            db.run('ROLLBACK');
            return res.status(500).json({ error: err.message });
          }
          res.status(204).send();
        });
      });
    });
  });
});
// Invoices Endpoints
app.get('/api/invoices', (req, res) => {
  const companyId = req.query.company_id || 1;
  console.log(`[API] GET /api/invoices called with company_id=${companyId}`);
  db.all(
    'SELECT i.*, c.name AS customer_name FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id WHERE i.company_id = ?',
    [companyId],
    (err, invoices) => {
      if (err) {
        console.error('[API] Error querying invoices:', err.message);
        return res.status(500).json({ error: err.message });
      }
      db.all(
        'SELECT ii.*, p.name AS product_name, p.sku, p.wholesale_price AS current_wholesale_price, p.retail_price FROM invoice_items ii LEFT JOIN products p ON ii.product_id = p.id WHERE ii.company_id = ?',
        [companyId],
        (err, items) => {
          if (err) {
            console.error('[API] Error querying invoice_items:', err.message);
            return res.status(500).json({ error: err.message });
          }
          invoices.forEach(invoice => {
            invoice.items = items.filter(item => item.transaction_id === invoice.id).map(item => ({
              ...item,
              cogs: item.quantity * (item.wholesale_price || 0)  // Always use stored, no fallback to current
            }));
          });
          res.json(invoices);
        });
    });
});
app.get('/api/invoices/:id', (req, res) => {
  const { id } = req.params;
  const companyId = req.query.company_id || 1;
  console.log(`[API] GET /api/invoices/${id} called with company_id=${companyId}`);
  db.get(
    'SELECT i.*, c.name AS customer_name FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id WHERE i.id = ? AND i.company_id = ?',
    [id, companyId],
    (err, invoice) => {
      if (err) {
        console.error('[API] Error querying invoice:', err.message);
        return res.status(500).json({ error: err.message });
      }
      if (!invoice) {
        console.error('[API] Invoice not found for id:', id);
        return res.status(404).json({ error: 'Invoice not found' });
      }
      db.all(
        'SELECT ii.*, p.name AS product_name, p.sku, p.wholesale_price AS current_wholesale_price, p.retail_price FROM invoice_items ii LEFT JOIN products p ON ii.product_id = p.id WHERE ii.transaction_id = ? AND ii.company_id = ?',
        [id, companyId],
        (err, items) => {
          if (err) {
            console.error('[API] Error querying invoice_items:', err.message);
            return res.status(500).json({ error: err.message });
          }
          invoice.items = items.map(item => ({
            ...item,
            cogs: item.quantity * (item.wholesale_price || 0)  // Always use stored, no fallback to current
          }));
          res.json(invoice);
        });
    });
});
app.post('/api/invoices', async (req, res) => {
  const { customer_id, items, discount, tax_rate, shipping, payment_method, date, subtotal, tax, total, notes, status, shipping_address, customer_po, company_id = 1 } = req.body;
  console.log(`[API] POST /api/invoices called with company_id=${company_id}, items_count=${items?.length || 0}`);
  if (!customer_id || !items || !Array.isArray(items) || items.length === 0 || !payment_method || !date || !status || !company_id) {
    console.error('[API] POST /api/invoices: Missing required fields');
    return res.status(400).json({ error: 'Missing required fields: customer_id, items, payment_method, date, status, and company_id are required' });
  }
  if (!['Pending', 'Approved'].includes(status)) {
    console.error('[API] POST /api/invoices: Invalid status:', status);
    return res.status(400).json({ error: 'Invalid status: must be Pending or Approved' });
  }
  try {
    const itemsWithWholesale = await Promise.all(items.map(async item => {
      if (!item.product_id || !item.quantity) {
        throw new Error('Invalid item: ' + JSON.stringify(item));
      }
      const product = await new Promise((resolve, reject) => {
        db.get('SELECT wholesale_price FROM products WHERE id = ? AND company_id = ?', [item.product_id, company_id], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });
      if (!product) {
        throw new Error(`Product not found for id: ${item.product_id}`);
      }
      return {
        ...item,
        wholesale_price: product.wholesale_price || 0  // Force 0 if null
      };
    }));
    const custRow = await dbGet('SELECT shipping_address, billing_address FROM customers WHERE id = ? AND company_id = ?', [customer_id, company_id]);
    const invShip = resolveShipTo({
      override: shipping_address,
      customer_shipping: custRow && custRow.shipping_address,
      customer_billing: custRow && custRow.billing_address
    }) || null;
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      db.run(
        'INSERT INTO invoices (customer_id, date, subtotal, tax, tax_rate, shipping, discount, total, payment_method, invoice_number, notes, company_id, customer_name, status, shipping_address, customer_po) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT name FROM customers WHERE id = ?), ?, ?, ?)',
        [customer_id, date, subtotal, tax, tax_rate, shipping, discount, total, payment_method, generateTransactionNumber(date), notes || 'Invoice for your payment', company_id, customer_id, status, invShip, (customer_po || '').trim() || null],
        function(err) {
          if (err) {
            console.error('[API] Error inserting invoice:', err.message);
            db.run('ROLLBACK');
            return res.status(500).json({ error: err.message });
          }
          const invoiceId = this.lastID;
          const insertItem = db.prepare('INSERT INTO invoice_items (transaction_id, product_id, quantity, custom_price, wholesale_price, company_id) VALUES (?, ?, ?, ?, ?, ?)');
          let itemErrors = [];
          itemsWithWholesale.forEach(item => {
            insertItem.run([invoiceId, item.product_id, item.quantity, item.custom_price, item.wholesale_price, company_id], err => {
              if (err) itemErrors.push(err.message);
            });
          });
          insertItem.finalize();
          if (itemErrors.length > 0) {
            console.error('[API] Error inserting invoice_items:', itemErrors.join('; '));
            db.run('ROLLBACK');
            return res.status(500).json({ error: 'Failed to insert items: ' + itemErrors.join('; ') });
          }
          db.run('COMMIT', err => {
            if (err) {
              console.error('[API] Error committing invoice:', err.message);
              db.run('ROLLBACK');
              return res.status(500).json({ error: err.message });
            }
            db.get(
              'SELECT i.*, c.name AS customer_name FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id WHERE i.id = ?',
              [invoiceId],
              (err, invoice) => {
                if (err) {
                  console.error('[API] Error fetching new invoice:', err.message);
                  return res.status(500).json({ error: err.message });
                }
                db.all('SELECT * FROM invoice_items WHERE transaction_id = ?', [invoiceId], (err, items) => {
                  if (err) {
                    console.error('[API] Error fetching invoice_items:', err.message);
                    return res.status(500).json({ error: err.message });
                  }
                  invoice.items = items;
                  res.status(201).json(invoice);
                });
              });
          });
        });
    });
  } catch (err) {
    console.error('[API] Error processing invoice:', err.message);
    res.status(500).json({ error: err.message });
  }
});
app.put('/api/invoices/:id', async (req, res) => {
  const { customer_id, items, discount, tax_rate, shipping, payment_method, date, subtotal, tax, total, status, shipping_address, notes, customer_po, company_id = 1 } = req.body;
  console.log(`[API] PUT /api/invoices/${req.params.id} called with company_id=${company_id}`);
  if (!customer_id || !items || !Array.isArray(items) || items.length === 0 || !payment_method || !date || !status || !company_id) {
    console.error('[API] PUT /api/invoices: Missing required fields');
    return res.status(400).json({ error: 'Missing required fields: customer_id, items, payment_method, date, status, and company_id are required' });
  }
  if (!['Pending', 'Approved', 'Converted', 'Paid', 'Void'].includes(status)) {
    console.error('[API] PUT /api/invoices: Invalid status:', status);
    return res.status(400).json({ error: 'Invalid status: must be Pending, Approved, Converted, Paid, or Void' });
  }
  try {
    const itemsWithWholesale = await Promise.all(items.map(async item => {
      if (!item.product_id || !item.quantity) {
        throw new Error('Invalid item: ' + JSON.stringify(item));
      }
      const product = await new Promise((resolve, reject) => {
        db.get('SELECT wholesale_price FROM products WHERE id = ? AND company_id = ?', [item.product_id, company_id], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });
      if (!product) {
        throw new Error(`Product not found for id: ${item.product_id}`);
      }
      return {
        ...item,
        wholesale_price: product.wholesale_price || 0  // Force 0 if null
      };
    }));
    const custRow = await dbGet('SELECT shipping_address, billing_address FROM customers WHERE id = ? AND company_id = ?', [customer_id, company_id]);
    const invShip = resolveShipTo({
      override: shipping_address,
      customer_shipping: custRow && custRow.shipping_address,
      customer_billing: custRow && custRow.billing_address
    }) || null;
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      db.run(
        'UPDATE invoices SET customer_id = ?, date = ?, subtotal = ?, tax = ?, tax_rate = ?, shipping = ?, discount = ?, total = ?, payment_method = ?, company_id = ?, customer_name = (SELECT name FROM customers WHERE id = ?), status = ?, shipping_address = ?, notes = ?, customer_po = ? WHERE id = ?',
        [customer_id, date, subtotal, tax, tax_rate, shipping, discount, total, payment_method, company_id, customer_id, status, invShip, notes || null, (customer_po || '').trim() || null, req.params.id],
        function(err) {
          if (err) {
            console.error('[API] Error updating invoice:', err.message);
            db.run('ROLLBACK');
            return res.status(500).json({ error: err.message });
          }
          if (this.changes === 0) {
            console.error('[API] Invoice not found for id:', req.params.id);
            db.run('ROLLBACK');
            return res.status(404).json({ error: 'Invoice not found' });
          }
          db.run('DELETE FROM invoice_items WHERE transaction_id = ? AND company_id = ?', [req.params.id, company_id], err => {
            if (err) {
              console.error('[API] Error deleting invoice_items:', err.message);
              db.run('ROLLBACK');
              return res.status(500).json({ error: err.message });
            }
            const insertItem = db.prepare('INSERT INTO invoice_items (transaction_id, product_id, quantity, custom_price, wholesale_price, company_id) VALUES (?, ?, ?, ?, ?, ?)');
            let itemErrors = [];
            itemsWithWholesale.forEach(item => {
              insertItem.run([req.params.id, item.product_id, item.quantity, item.custom_price, item.wholesale_price, company_id], err => {
                if (err) itemErrors.push(err.message);
              });
            });
            insertItem.finalize();
            if (itemErrors.length > 0) {
              console.error('[API] Error inserting invoice_items:', itemErrors.join('; '));
              db.run('ROLLBACK');
              return res.status(500).json({ error: 'Failed to insert items: ' + itemErrors.join('; ') });
            }
            db.run('COMMIT', err => {
              if (err) {
                console.error('[API] Error committing invoice update:', err.message);
                db.run('ROLLBACK');
                return res.status(500).json({ error: err.message });
              }
              db.get(
                'SELECT i.*, c.name AS customer_name FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id WHERE i.id = ?',
                [req.params.id],
                (err, invoice) => {
                  if (err) {
                    console.error('[API] Error fetching updated invoice:', err.message);
                    return res.status(500).json({ error: err.message });
                  }
                  db.all('SELECT * FROM invoice_items WHERE transaction_id = ?', [req.params.id], (err, items) => {
                    if (err) {
                      console.error('[API] Error fetching invoice_items:', err.message);
                      return res.status(500).json({ error: err.message });
                    }
                    invoice.items = items;
                    res.json(invoice);
                  });
                });
            });
          });
        });
    });
  } catch (err) {
    console.error('[API] Error processing invoice update:', err.message);
    res.status(500).json({ error: err.message });
  }
});
app.delete('/api/invoices/:id', (req, res) => {
  const companyId = req.query.company_id || 1;
  console.log(`[API] DELETE /api/invoices/${req.params.id} called with company_id=${companyId}`);
  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    db.run('DELETE FROM invoice_items WHERE transaction_id = ? AND company_id = ?', [req.params.id, companyId], err => {
      if (err) {
        console.error('[API] Error deleting invoice_items:', err.message);
        db.run('ROLLBACK');
        return res.status(500).json({ error: err.message });
      }
      db.run('DELETE FROM invoices WHERE id = ? AND company_id = ?', [req.params.id, companyId], function(err) {
        if (err) {
          console.error('[API] Error deleting invoice:', err.message);
          db.run('ROLLBACK');
          return res.status(500).json({ error: err.message });
        }
        if (this.changes === 0) {
          console.error('[API] Invoice not found for id:', req.params.id);
          db.run('ROLLBACK');
          return res.status(404).json({ error: 'Invoice not found' });
        }
        db.run('COMMIT', err => {
          if (err) {
            console.error('[API] Error committing invoice deletion:', err.message);
            db.run('ROLLBACK');
            return res.status(500).json({ error: err.message });
          }
          res.status(204).send();
        });
      });
    });
  });
});
// Transactions Endpoint
app.get('/api/transactions', (req, res) => {
  const companyId = req.query.company_id || 1;
  db.all(
    'SELECT id, "sale" AS type, total AS amount, date, id AS related_id FROM sales WHERE company_id = ? UNION ALL SELECT id, "purchase" AS type, amount, bill_date AS date, id AS related_id FROM bills WHERE company_id = ?',
    [companyId, companyId],
    (err, transactions) => {
      if (err) {
        console.error('[API] Error querying transactions:', err.message);
        return res.status(500).json({ error: err.message });
      }
      res.json(transactions);
    });
});
// Deposits endpoints
app.get('/api/deposits', (req, res) => {
  const companyId = req.query.company_id || 2;
  db.all(
    'SELECT d.*, c.name AS customer_name FROM deposits d LEFT JOIN customers c ON d.customer_id = c.id WHERE d.company_id = ?',
    [companyId],
    (err, deposits) => {
      if (err) {
        console.error('[API] Error querying deposits:', err.message);
        return res.status(500).json({ error: err.message });
      }
      res.json(deposits);
    });
});
app.post('/api/deposits', (req, res) => {
  const { customer_id, amount, type, date, description, company_id = 2 } = req.body;
  if (!customer_id || !amount || !type || !date) {
    console.error('[API] POST /api/deposits: Missing required fields');
    return res.status(400).json({ error: 'Missing required fields' });
  }
  db.run(
    'INSERT INTO deposits (customer_id, amount, type, date, description, company_id) VALUES (?, ?, ?, ?, ?, ?)',
    [customer_id, amount, type, date, description, company_id],
    function(err) {
      if (err) {
        console.error('[API] Error inserting deposit:', err.message);
        return res.status(500).json({ error: err.message });
      }
      db.get(
        'SELECT d.*, c.name AS customer_name FROM deposits d LEFT JOIN customers c ON d.customer_id = c.id WHERE d.id = ?',
        [this.lastID],
        (err, deposit) => {
          if (err) {
            console.error('[API] Error fetching new deposit:', err.message);
            return res.status(500).json({ error: err.message });
          }
          res.status(201).json(deposit);
        });
    });
});
app.put('/api/deposits/:id', (req, res) => {
  const { customer_id, amount, type, date, description, company_id } = req.body;
  if (!customer_id || !amount || !type || !date) {
    console.error('[API] PUT /api/deposits: Missing required fields');
    return res.status(400).json({ error: 'Missing required fields' });
  }
  db.run(
    'UPDATE deposits SET customer_id = ?, amount = ?, type = ?, date = ?, description = ?, company_id = ? WHERE id = ?',
    [customer_id, amount, type, date, description, company_id, req.params.id],
    function(err) {
      if (err) {
        console.error('[API] Error updating deposit:', err.message);
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) {
        console.error('[API] Deposit not found for id:', req.params.id);
        return res.status(404).json({ error: 'Deposit not found' });
      }
      db.get(
        'SELECT d.*, c.name AS customer_name FROM deposits d LEFT JOIN customers c ON d.customer_id = c.id WHERE d.id = ?',
        [req.params.id],
        (err, deposit) => {
          if (err) {
            console.error('[API] Error fetching updated deposit:', err.message);
            return res.status(500).json({ error: err.message });
          }
          res.json(deposit);
        });
    });
});
app.delete('/api/deposits/:id', (req, res) => {
  const companyId = req.query.company_id || 2;
  db.run(
    'DELETE FROM deposits WHERE id = ? AND company_id = ?',
    [req.params.id, companyId],
    function(err) {
      if (err) {
        console.error('[API] Error deleting deposit:', err.message);
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) {
        console.error('[API] Deposit not found for id:', req.params.id);
        return res.status(404).json({ error: 'Deposit not found' });
      }
      res.status(204).send();
    });
});
// Expenses endpoints
app.get('/api/expenses', (req, res) => {
  const companyId = req.query.company_id || 2;
  db.all(
    'SELECT e.*, v.name AS vendor_name, c.name AS category_name FROM expenses e LEFT JOIN vendors v ON e.vendor_id = v.id LEFT JOIN expense_categories c ON e.category_id = c.id WHERE e.company_id = ?',
    [companyId],
    (err, expenses) => {
      if (err) {
        console.error('[API] Error querying expenses:', err.message);
        return res.status(500).json({ error: err.message });
      }
      res.json(expenses);
    });
});
app.post('/api/expenses', (req, res) => {
  const { vendor_id, category_id, amount, date, description, company_id = 2 } = req.body;
  if (!vendor_id || !category_id || !amount || !date) {
    console.error('[API] POST /api/expenses: Missing required fields');
    return res.status(400).json({ error: 'Missing required fields' });
  }
  db.run(
    'INSERT INTO expenses (vendor_id, category_id, amount, date, description, company_id) VALUES (?, ?, ?, ?, ?, ?)',
    [vendor_id, category_id, amount, date, description, company_id],
    function(err) {
      if (err) {
        console.error('[API] Error inserting expense:', err.message);
        return res.status(500).json({ error: err.message });
      }
      db.get(
        'SELECT e.*, v.name AS vendor_name, c.name AS category_name FROM expenses e LEFT JOIN vendors v ON e.vendor_id = v.id LEFT JOIN expense_categories c ON e.category_id = c.id WHERE e.id = ?',
        [this.lastID],
        (err, expense) => {
          if (err) {
            console.error('[API] Error fetching new expense:', err.message);
            return res.status(500).json({ error: err.message });
          }
          res.status(201).json(expense);
        });
    });
});
app.put('/api/expenses/:id', (req, res) => {
  const { vendor_id, category_id, amount, date, description, company_id } = req.body;
  if (!vendor_id || !category_id || !amount || !date) {
    console.error('[API] PUT /api/expenses: Missing required fields');
    return res.status(400).json({ error: 'Missing required fields' });
  }
  db.run(
    'UPDATE expenses SET vendor_id = ?, category_id = ?, amount = ?, date = ?, description = ?, company_id = ? WHERE id = ?',
    [vendor_id, category_id, amount, date, description, company_id, req.params.id],
    function(err) {
      if (err) {
        console.error('[API] Error updating expense:', err.message);
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) {
        console.error('[API] Expense not found for id:', req.params.id);
        return res.status(404).json({ error: 'Expense not found' });
      }
      db.get(
        'SELECT e.*, v.name AS vendor_name, c.name AS category_name FROM expenses e LEFT JOIN vendors v ON e.vendor_id = v.id LEFT JOIN expense_categories c ON e.category_id = c.id WHERE e.id = ?',
        [req.params.id],
        (err, expense) => {
          if (err) {
            console.error('[API] Error fetching updated expense:', err.message);
            return res.status(500).json({ error: err.message });
          }
          res.json(expense);
        });
    });
});
app.delete('/api/expenses/:id', (req, res) => {
  const companyId = req.query.company_id || 2;
  db.run(
    'DELETE FROM expenses WHERE id = ? AND company_id = ?',
    [req.params.id, companyId],
    function(err) {
      if (err) {
        console.error('[API] Error deleting expense:', err.message);
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) {
        console.error('[API] Expense not found for id:', req.params.id);
        return res.status(404).json({ error: 'Expense not found' });
      }
      res.status(204).send();
    });
});
// Expense Categories Endpoints
app.get('/api/expense_categories', (req, res) => {
  const companyId = req.query.company_id || 1;
  db.all('SELECT * FROM expense_categories WHERE company_id = ?', [companyId], (err, categories) => {
    if (err) {
      console.error('[API] Error querying expense categories:', err.message);
      return res.status(500).json({ error: err.message });
    }
    res.json(categories);
  });
});
app.post('/api/expense_categories', (req, res) => {
  const { name, company_id = 1 } = req.body;
  if (!name || !company_id) {
    console.error('[API] POST /api/expense_categories: Missing required fields');
    return res.status(400).json({ error: 'Missing required fields' });
  }
  db.run(
    'INSERT INTO expense_categories (name, company_id) VALUES (?, ?)',
    [name, company_id],
    function(err) {
      if (err) {
        console.error('[API] Error inserting expense category:', err.message);
        return res.status(500).json({ error: err.message });
      }
      db.get('SELECT * FROM expense_categories WHERE id = ?', [this.lastID], (err, category) => {
        if (err) {
          console.error('[API] Error fetching new expense category:', err.message);
          return res.status(500).json({ error: err.message });
        }
        res.status(201).json(category);
      });
    });
});
app.get('/api/sales_tax_payments', (req, res) => {
  const companyId = req.query.company_id || 1;
  // Table column is payment_date (snake_case); expose paymentDate for the UI
  db.all(
    `SELECT id, year, paid, payment_date AS paymentDate, company_id
     FROM sales_tax_payments WHERE company_id = ?`,
    [companyId],
    (err, payments) => {
      if (err) {
        console.error('[API] Error querying sales tax payments:', err.message);
        return res.status(500).json({ error: err.message });
      }
      res.json(
        (payments || []).map((p) => ({
          ...p,
          paid: p.paid === 1 || p.paid === true || p.paid === '1',
        }))
      );
    }
  );
});
app.post('/api/sales_tax_payments', (req, res) => {
  const { year, paid, company_id = 1 } = req.body;
  const paymentDate =
    req.body.paymentDate ||
    req.body.payment_date ||
    new Date().toISOString().replace('T', ' ').slice(0, 19);
  if (year === undefined || year === null || year === '' || paid === undefined) {
    console.error('[API] POST /api/sales_tax_payments: Missing required fields', req.body);
    return res.status(400).json({ error: 'Missing required fields: year and paid' });
  }
  const yearNum = Number(year);
  const paidInt = paid === true || paid === 1 || paid === '1' || paid === 'true' ? 1 : 0;
  const companyId = Number(company_id) || 1;

  // Upsert by year + company (mark paid / refresh date)
  db.get(
    'SELECT id FROM sales_tax_payments WHERE year = ? AND company_id = ?',
    [yearNum, companyId],
    (err, existing) => {
      if (err) {
        console.error('[API] Error checking sales tax payment:', err.message);
        return res.status(500).json({ error: err.message });
      }
      const finish = (id) => {
        db.get(
          `SELECT id, year, paid, payment_date AS paymentDate, company_id
           FROM sales_tax_payments WHERE id = ?`,
          [id],
          (err2, payment) => {
            if (err2) {
              console.error('[API] Error fetching sales tax payment:', err2.message);
              return res.status(500).json({ error: err2.message });
            }
            res.status(existing ? 200 : 201).json({
              ...payment,
              paid: payment.paid === 1 || payment.paid === true || payment.paid === '1',
            });
          }
        );
      };
      if (existing) {
        db.run(
          'UPDATE sales_tax_payments SET paid = ?, payment_date = ? WHERE id = ?',
          [paidInt, paymentDate, existing.id],
          function (errU) {
            if (errU) {
              console.error('[API] Error updating sales tax payment:', errU.message);
              return res.status(500).json({ error: errU.message });
            }
            finish(existing.id);
          }
        );
      } else {
        db.run(
          'INSERT INTO sales_tax_payments (year, paid, payment_date, company_id) VALUES (?, ?, ?, ?)',
          [yearNum, paidInt, paymentDate, companyId],
          function (errI) {
            if (errI) {
              console.error('[API] Error inserting sales tax payment:', errI.message);
              return res.status(500).json({ error: errI.message });
            }
            finish(this.lastID);
          }
        );
      }
    }
  );
});
app.get('/api/inventory_snapshots', (req, res) => {
  const companyId = req.query.company_id || 1;
  db.all('SELECT * FROM inventory_snapshots WHERE company_id = ? ORDER BY snapshot_date DESC', [companyId], (err, snapshots) => {
    if (err) {
      console.error('[API] Error querying inventory snapshots:', err.message);
      return res.status(500).json({ error: err.message });
    }
    res.json(snapshots);
  });
});
app.post('/api/inventory_snapshots', async (req, res) => {
  const { total_value, snapshot_date, company_id = 1 } = req.body;
  if (!total_value || !snapshot_date) {
    console.error('[API] POST /api/inventory_snapshots: Missing required fields');
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    const existingSnapshot = await new Promise((resolve, reject) => {
      db.get('SELECT id FROM inventory_snapshots WHERE snapshot_date = ? AND company_id = ?', [snapshot_date, company_id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    if (existingSnapshot) {
      return res.status(400).json({ error: `Snapshot already exists for ${snapshot_date}` });
    }
    await new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO inventory_snapshots (total_value, snapshot_date, company_id) VALUES (?, ?, ?)',
        [total_value, snapshot_date, company_id],
        function(err) {
          if (err) {
            console.error('[API] Error inserting inventory snapshot:', err.message);
            reject(err);
          } else {
            resolve();
          }
        });
    });
    const snapshot = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM inventory_snapshots WHERE snapshot_date = ? AND company_id = ?', [snapshot_date, company_id], (err, row) => {
        if (err) {
          console.error('[API] Error fetching new inventory snapshot:', err.message);
          reject(err);
        } else {
          resolve(row);
        }
      });
    });
    res.status(201).json({ success: true, snapshot });
  } catch (err) {
    console.error('[API] Error processing inventory snapshot:', err.message);
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/receive_inventory', async (req, res) => {
  const { purchase_order_id, items, company_id = 1, bill_date, due_date } = req.body;
  console.log(`[API] POST /api/receive_inventory po=${purchase_order_id} items=${items?.length || 0} company_id=${company_id}`);

  if (!purchase_order_id || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'purchase_order_id and items array (with received_quantity) are required' });
  }

  try {
    await dbRun('BEGIN IMMEDIATE TRANSACTION');

    const po = await dbGet(
      'SELECT vendor_id FROM purchase_orders WHERE id = ? AND company_id = ?',
      [purchase_order_id, company_id]
    );
    if (!po) throw new Error('Purchase order not found');

    let totalAmount = 0;

    for (const item of items) {
      const item_id = item.id;
      const received_quantity = Number(item.received_quantity);
      if (!item_id || !Number.isFinite(received_quantity) || received_quantity < 0) {
        throw new Error(`Invalid item: ${JSON.stringify(item)}`);
      }
      if (received_quantity === 0) continue;

      const poItem = await dbGet(
        'SELECT product_id, unit_price, received_quantity, quantity FROM purchase_order_items WHERE id = ? AND purchase_order_id = ?',
        [item_id, purchase_order_id]
      );
      if (!poItem) throw new Error(`Item ${item_id} not found in PO`);

      const newReceived = (poItem.received_quantity || 0) + received_quantity;
      if (newReceived > poItem.quantity) {
        throw new Error(`Cannot receive more (${newReceived}) than ordered (${poItem.quantity}) for item ${item_id}`);
      }

      await dbRun(
        'UPDATE purchase_order_items SET received_quantity = ? WHERE id = ?',
        [newReceived, item_id]
      );

      await dbRun(
        'UPDATE products SET stock = COALESCE(stock, 0) + ? WHERE id = ?',
        [received_quantity, poItem.product_id]
      );

      await dbRun(
        'INSERT INTO inventory_transactions (purchase_order_id, product_id, quantity, transaction_type, transaction_date, company_id) VALUES (?, ?, ?, ?, ?, ?)',
        [purchase_order_id, poItem.product_id, received_quantity, 'receive', new Date().toISOString().split('T')[0], company_id]
      );

      totalAmount += received_quantity * (poItem.unit_price || 0);
    }

    const allItems = await dbAll(
      'SELECT quantity, received_quantity FROM purchase_order_items WHERE purchase_order_id = ?',
      [purchase_order_id]
    );
    const fullyReceived = allItems.length > 0 && allItems.every(i => (i.received_quantity || 0) >= i.quantity);

    if (fullyReceived) {
      await dbRun(
        'UPDATE purchase_orders SET status = ? WHERE id = ?',
        ['received', purchase_order_id]
      );
    }

    if (totalAmount > 0) {
      const billNumber = `BILL-PO${purchase_order_id}-${Date.now().toString().slice(-6)}`;

      await dbRun(
        `INSERT INTO bills (
          bill_number, vendor_id, purchase_order_id, amount,
          bill_date, due_date, is_inventory_bill, paid, status, company_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          billNumber,
          po.vendor_id,
          purchase_order_id,
          totalAmount,
          bill_date || new Date().toISOString().split('T')[0],
          due_date || null,
          1,
          0,
          'pending',
          company_id
        ]
      );
    }

    await dbRun('COMMIT');
    console.log(`[API] receive_inventory OK po=${purchase_order_id} total=${totalAmount} fully=${fullyReceived}`);

    res.json({
      success: true,
      total_received: totalAmount,
      fully_received: fullyReceived
    });

  } catch (err) {
    console.error('[receive_inventory] Error:', err.message);
    try { await dbRun('ROLLBACK'); } catch (rErr) { console.error('Rollback failed:', rErr.message); }
    res.status(500).json({ error: err.message });
  }
  
});

app.post('/api/inventory_transactions', (req, res) => {
  const { purchase_order_id, product_id, quantity, transaction_type, transaction_date, company_id, notes } = req.body;
  if (!product_id || !quantity || !transaction_type || !transaction_date || !company_id) {
    console.error('[API] POST /api/inventory_transactions: Missing required fields');
    return res.status(400).json({ error: 'Missing required fields' });
  }
  db.run(
    'INSERT INTO inventory_transactions (purchase_order_id, product_id, quantity, transaction_type, transaction_date, company_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [purchase_order_id, product_id, quantity, transaction_type, transaction_date, company_id, notes],
    function(err) {
      if (err) {
        console.error('[API] Error inserting inventory transaction:', err.message);
        return res.status(500).json({ error: err.message });
      }
      db.get('SELECT * FROM inventory_transactions WHERE id = ?', [this.lastID], (err, transaction) => {
        if (err) {
          console.error('[API] Error fetching new inventory transaction:', err.message);
          return res.status(500).json({ error: err.message });
        }
        res.status(201).json(transaction);
      });
    });
});
app.get('/api/reports/sales', (req, res) => {
  const company_id = req.query.company_id || 1;
  const range = resolveReportRange(req.query);
  const query = `SELECT s.*, c.name AS customer_name
    FROM sales s LEFT JOIN customers c ON s.customer_id = c.id
    WHERE s.company_id = ? AND s.date >= ? AND s.date <= ?
    ORDER BY s.date DESC`;
  const params = [company_id, range.startDate, range.endDate];
  db.all(query, params, (err, sales) => {
    if (err) {
      console.error('[API] Error querying sales report:', err.message);
      return res.status(500).json({ error: err.message });
    }
    // Prefer items linked to those sales; fall back to product wholesale if line wholesale missing
    const saleIds = (sales || []).map(s => s.id);
    if (saleIds.length === 0) return res.json([]);
    const placeholders = saleIds.map(() => '?').join(',');
    db.all(
      `SELECT si.*, p.name AS product_name, p.sku,
              p.wholesale_price AS current_wholesale_price, p.retail_price
       FROM sale_items si
       LEFT JOIN products p ON si.product_id = p.id
       WHERE si.transaction_id IN (${placeholders})`,
      saleIds,
      (err, items) => {
        if (err) {
          console.error('[API] Error querying sale_items for report:', err.message);
          return res.status(500).json({ error: err.message });
        }
        sales.forEach(sale => {
          sale.items = items.filter(item => item.transaction_id === sale.id).map(item => {
            const unitCost = Number(item.wholesale_price != null ? item.wholesale_price : (item.current_wholesale_price || 0));
            const qty = Number(item.quantity || 0);
            return {
              ...item,
              unit_cost: unitCost,
              // cogs is TOTAL line cost — do NOT multiply by quantity again on the client
              cogs: qty * unitCost,
            };
          });
        });
        res.json(sales);
      });
  });
});

app.get('/api/reports/bills', (req, res) => {
  const company_id = req.query.company_id || 1;
  const range = resolveReportRange(req.query);
  const query = `SELECT b.*, v.name AS vendor_name, ec.name AS category_name
    FROM bills b
    LEFT JOIN vendors v ON b.vendor_id = v.id
    LEFT JOIN expense_categories ec ON b.expense_category_id = ec.id
    WHERE b.company_id = ? AND b.bill_date >= ? AND b.bill_date <= ?
    ORDER BY b.bill_date DESC`;
  db.all(query, [company_id, range.startDate, range.endDate], (err, bills) => {
    if (err) {
      console.error('[API] Error querying bills report:', err.message);
      return res.status(500).json({ error: err.message });
    }
    res.json(bills);
  });
});

/**
 * Full Profit & Loss (QuickBooks-style) for a company + period.
 * Income from product sales AND deposits (deposit income is included);
 * COGS from sale_items; OpEx from non-inventory bills + expenses table.
 */
app.get('/api/reports/pnl', async (req, res) => {
  try {
    const company_id = Number(req.query.company_id || 1);
    const range = resolveReportRange(req.query);
    const { startDate, endDate } = range;

    const salesAgg = await dbGet(
      `SELECT
         COUNT(*) AS sale_count,
         COALESCE(SUM(subtotal), 0) AS subtotal,
         COALESCE(SUM(tax), 0) AS tax,
         COALESCE(SUM(shipping), 0) AS shipping,
         COALESCE(SUM(discount), 0) AS discount,
         COALESCE(SUM(total), 0) AS total
       FROM sales
       WHERE company_id = ? AND date >= ? AND date <= ?`,
      [company_id, startDate, endDate]
    );

    // Deposit rows count as income in addition to product sales
    const depositsAgg = await dbGet(
      `SELECT
         COUNT(*) AS deposit_count,
         COALESCE(SUM(amount), 0) AS amount
       FROM deposits
       WHERE company_id = ? AND date >= ? AND date <= ?`,
      [company_id, startDate, endDate]
    );

    const depositsByType = await dbAll(
      `SELECT COALESCE(type, 'Deposit') AS type,
              COUNT(*) AS count,
              COALESCE(SUM(amount), 0) AS amount
       FROM deposits
       WHERE company_id = ? AND date >= ? AND date <= ?
       GROUP BY type
       ORDER BY amount DESC`,
      [company_id, startDate, endDate]
    );

    const cogsRow = await dbGet(
      `SELECT COALESCE(SUM(
          si.quantity * COALESCE(si.wholesale_price, p.wholesale_price, 0)
        ), 0) AS cogs
       FROM sale_items si
       INNER JOIN sales s ON s.id = si.transaction_id
       LEFT JOIN products p ON p.id = si.product_id
       WHERE s.company_id = ? AND s.date >= ? AND s.date <= ?`,
      [company_id, startDate, endDate]
    );

    const billOpEx = await dbGet(
      `SELECT COALESCE(SUM(amount), 0) AS amount
       FROM bills
       WHERE company_id = ? AND bill_date >= ? AND bill_date <= ?
         AND (is_inventory_bill IS NULL OR is_inventory_bill = 0 OR is_inventory_bill = '0')`,
      [company_id, startDate, endDate]
    );

    const billInventory = await dbGet(
      `SELECT COALESCE(SUM(amount), 0) AS amount
       FROM bills
       WHERE company_id = ? AND bill_date >= ? AND bill_date <= ?
         AND (is_inventory_bill = 1 OR is_inventory_bill = '1')`,
      [company_id, startDate, endDate]
    );

    const expenseRows = await dbAll(
      `SELECT e.*, v.name AS vendor_name, ec.name AS category_name
       FROM expenses e
       LEFT JOIN vendors v ON e.vendor_id = v.id
       LEFT JOIN expense_categories ec ON e.category_id = ec.id
       WHERE e.company_id = ? AND e.date >= ? AND e.date <= ?`,
      [company_id, startDate, endDate]
    );
    const expensesTableTotal = expenseRows.reduce((s, r) => s + Number(r.amount || 0), 0);

    const expenseByCategoryBills = await dbAll(
      `SELECT COALESCE(ec.name, 'Uncategorized') AS category,
              COALESCE(SUM(b.amount), 0) AS amount
       FROM bills b
       LEFT JOIN expense_categories ec ON b.expense_category_id = ec.id
       WHERE b.company_id = ? AND b.bill_date >= ? AND b.bill_date <= ?
         AND (b.is_inventory_bill IS NULL OR b.is_inventory_bill = 0 OR b.is_inventory_bill = '0')
       GROUP BY category
       ORDER BY amount DESC`,
      [company_id, startDate, endDate]
    );

    const expenseByCategoryExpenses = await dbAll(
      `SELECT COALESCE(ec.name, 'Uncategorized') AS category,
              COALESCE(SUM(e.amount), 0) AS amount
       FROM expenses e
       LEFT JOIN expense_categories ec ON e.category_id = ec.id
       WHERE e.company_id = ? AND e.date >= ? AND e.date <= ?
       GROUP BY category
       ORDER BY amount DESC`,
      [company_id, startDate, endDate]
    );

    // Merge category maps
    const catMap = {};
    for (const row of expenseByCategoryBills) {
      catMap[row.category] = (catMap[row.category] || 0) + Number(row.amount || 0);
    }
    for (const row of expenseByCategoryExpenses) {
      catMap[row.category] = (catMap[row.category] || 0) + Number(row.amount || 0);
    }

    const productSubtotal = Number(salesAgg.subtotal || 0);
    const taxCollected = Number(salesAgg.tax || 0);
    const shippingIncome = Number(salesAgg.shipping || 0);
    const discounts = Number(salesAgg.discount || 0);
    const productGrossReceipts = Number(salesAgg.total || 0);
    const depositIncome = Number(depositsAgg.amount || 0);
    const depositCount = Number(depositsAgg.deposit_count || 0);
    const cogs = Number(cogsRow.cogs || 0);
    const opExBills = Number(billOpEx.amount || 0);
    const opExExpenses = expensesTableTotal;
    // Books module: checks, interest, depreciation, tax payments
    let books = {
      operating_from_checks: 0,
      interest_expense: 0,
      depreciation_expense: 0,
      owner_draws: 0,
      loan_principal_paid: 0,
      tax_payments_expense: 0,
      prepaid_tax_payments: 0,
      asset_purchases: 0,
      check_expense_by_category: [],
      check_count: 0,
    };
    try {
      books = await getBooksPnlExtras(db, company_id, startDate, endDate);
    } catch (booksErr) {
      console.warn('[API] books P&L extras:', booksErr.message);
    }

    const operatingExpenses =
      opExBills +
      opExExpenses +
      Number(books.operating_from_checks || 0) +
      Number(books.interest_expense || 0) +
      Number(books.depreciation_expense || 0);
    // Product net sales ≈ subtotal + shipping - discount
    const productNetSales = productSubtotal + shippingIncome - discounts;
    // Total income = product sales + deposits 
    const totalIncome = productNetSales + depositIncome;
    const grossReceipts = productGrossReceipts + depositIncome;
    // COGS only applies to product sales; deposit income is pure (no inventory COGS)
    const grossProfit = totalIncome - cogs;
    // Net operating income before owner draws & estimated income tax
    const netOperatingIncome = grossProfit - operatingExpenses;
    // Other income from books receipts (not client reimbursements — those clear AR)
    const booksOtherIncome =
      Number(books.other_income_receipts || 0) +
      Number(books.reimbursement_excess_income || 0);
    // Estimated / income tax payments (often tracked for CPA; not owner draws)
    const incomeTaxPayments = Number(books.tax_payments_expense || 0);
    const netIncome = netOperatingIncome + booksOtherIncome - incomeTaxPayments;
    const grossMarginPct = totalIncome > 0 ? (grossProfit / totalIncome) * 100 : 0;
    const netMarginPct = totalIncome > 0 ? (netIncome / totalIncome) * 100 : 0;

    // Merge check expense categories into by_category
    for (const row of books.check_expense_by_category || []) {
      catMap[row.category] = (catMap[row.category] || 0) + Number(row.amount || 0);
    }
    if (books.interest_expense > 0) {
      catMap['Interest expense (loans)'] =
        (catMap['Interest expense (loans)'] || 0) + Number(books.interest_expense);
    }
    if (books.depreciation_expense > 0) {
      catMap['Depreciation'] =
        (catMap['Depreciation'] || 0) + Number(books.depreciation_expense);
    }
    const expensesByCategoryMerged = Object.entries(catMap)
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount);


    res.json({
      company_id,
      range,
      income: {
        // net_sales is total income (products + deposits) so KPIs work for both companies
        net_sales: totalIncome,
        total_income: totalIncome,
        product_net_sales: productNetSales,
        product_subtotal: productSubtotal,
        shipping: shippingIncome,
        discounts,
        deposit_income: depositIncome,
        deposit_count: depositCount,
        deposits_by_type: depositsByType,
        tax_collected: taxCollected,
        gross_receipts: grossReceipts,
        sale_count: Number(salesAgg.sale_count || 0),
      },
      cogs: {
        product_cogs: cogs,
        inventory_bills: Number(billInventory.amount || 0), // purchased inventory (balance-sheet-ish; not OpEx)
      },
      gross_profit: grossProfit,
      gross_margin_pct: grossMarginPct,
      expenses: {
        from_bills: opExBills,
        from_expenses_table: opExExpenses,
        from_checks: Number(books.operating_from_checks || 0),
        interest_expense: Number(books.interest_expense || 0),
        depreciation_expense: Number(books.depreciation_expense || 0),
        total: operatingExpenses,
        by_category: expensesByCategoryMerged,
      },
      net_operating_income: netOperatingIncome,
      income_tax_payments: incomeTaxPayments,
      net_income: netIncome,
      net_margin_pct: netMarginPct,
      // Balance-sheet / equity items (not operating expenses) — for CPA package
      books: {
        owner_draws: Number(books.owner_draws || 0),
        loan_principal_paid: Number(books.loan_principal_paid || 0),
        prepaid_tax_payments: Number(books.prepaid_tax_payments || 0),
        asset_purchases: Number(books.asset_purchases || 0),
        check_count: Number(books.check_count || 0),
        reimbursable_paid: Number(books.reimbursable_paid || 0),
        reimbursements_received: Number(books.reimbursements_received || 0),
        reimbursable_open: Number(books.reimbursable_open || 0),
        reimbursement_excess_income: Number(books.reimbursement_excess_income || 0),
        other_income_receipts: Number(books.other_income_receipts || 0),
        refunds_offset: Number(books.refunds_offset || 0),
        payments_by_method: books.payments_by_method || [],
        receipt_count: Number(books.receipt_count || 0),
        meals_expense: Number(books.meals_expense || 0),
        meals_deductible_estimate: Number(books.meals_deductible_estimate || 0),
        intercompany_paid: Number(books.intercompany_paid || 0),
      },
      other_income: {
        reimbursement_excess: Number(books.reimbursement_excess_income || 0),
        receipts: Number(books.other_income_receipts || 0),
        total:
          Number(books.reimbursement_excess_income || 0) +
          Number(books.other_income_receipts || 0),
      },
    });
  } catch (err) {
    console.error('[API] /api/reports/pnl error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Monthly trend series for charts (revenue, COGS, expenses, net income).
 * Prefer the same period/startDate/endDate as /api/reports/pnl.
 * Fallback: last N months (query.months, default 12) ending at endDate or today.
 */
app.get('/api/reports/trends', async (req, res) => {
  try {
    const company_id = Number(req.query.company_id || 1);
    const zone = 'America/Los_Angeles';
    let start;
    let end;
    let rangeMeta = null;

    // Align with P&L when period or explicit dates are provided
    if (req.query.period || (req.query.startDate && req.query.endDate)) {
      rangeMeta = resolveReportRange(req.query);
      start = DateTime.fromISO(rangeMeta.startDate, { zone }).startOf('month');
      end = DateTime.fromISO(rangeMeta.endDate, { zone }).endOf('month');
      // Do not extend past the selected end day for the last month's endDate filter
      // (SQL still uses exact endDate below)
    } else {
      const months = Math.min(36, Math.max(1, Number(req.query.months || 12)));
      end = req.query.endDate
        ? DateTime.fromISO(String(req.query.endDate), { zone }).endOf('month')
        : DateTime.now().setZone(zone).endOf('month');
      start = end.minus({ months: months - 1 }).startOf('month');
    }

    const startDate = (rangeMeta && rangeMeta.startDate)
      ? rangeMeta.startDate
      : start.toFormat('yyyy-MM-dd');
    const endDate = (rangeMeta && rangeMeta.endDate)
      ? rangeMeta.endDate
      : end.toFormat('yyyy-MM-dd');
    // Month iteration bounds (inclusive)
    const monthStart = DateTime.fromISO(startDate, { zone }).startOf('month');
    const monthEnd = DateTime.fromISO(endDate, { zone }).startOf('month');

    const salesByMonth = await dbAll(
      `SELECT strftime('%Y-%m', date) AS month,
              COALESCE(SUM(subtotal), 0) AS subtotal,
              COALESCE(SUM(shipping), 0) AS shipping,
              COALESCE(SUM(discount), 0) AS discount,
              COALESCE(SUM(total), 0) AS total,
              COALESCE(SUM(tax), 0) AS tax,
              COUNT(*) AS sale_count
       FROM sales
       WHERE company_id = ? AND date >= ? AND date <= ?
       GROUP BY month
       ORDER BY month`,
      [company_id, startDate, endDate]
    );

    const cogsByMonth = await dbAll(
      `SELECT strftime('%Y-%m', s.date) AS month,
              COALESCE(SUM(si.quantity * COALESCE(si.wholesale_price, p.wholesale_price, 0)), 0) AS cogs
       FROM sale_items si
       INNER JOIN sales s ON s.id = si.transaction_id
       LEFT JOIN products p ON p.id = si.product_id
       WHERE s.company_id = ? AND s.date >= ? AND s.date <= ?
       GROUP BY month
       ORDER BY month`,
      [company_id, startDate, endDate]
    );

    const billsByMonth = await dbAll(
      `SELECT strftime('%Y-%m', bill_date) AS month,
              COALESCE(SUM(CASE WHEN is_inventory_bill = 1 OR is_inventory_bill = '1' THEN 0 ELSE amount END), 0) AS opex,
              COALESCE(SUM(CASE WHEN is_inventory_bill = 1 OR is_inventory_bill = '1' THEN amount ELSE 0 END), 0) AS inventory_bills
       FROM bills
       WHERE company_id = ? AND bill_date >= ? AND bill_date <= ?
       GROUP BY month
       ORDER BY month`,
      [company_id, startDate, endDate]
    );

    const expensesByMonth = await dbAll(
      `SELECT strftime('%Y-%m', date) AS month,
              COALESCE(SUM(amount), 0) AS amount
       FROM expenses
       WHERE company_id = ? AND date >= ? AND date <= ?
       GROUP BY month
       ORDER BY month`,
      [company_id, startDate, endDate]
    );

    // Deposit income is included below
    const depositsByMonth = await dbAll(
      `SELECT strftime('%Y-%m', date) AS month,
              COALESCE(SUM(amount), 0) AS amount,
              COUNT(*) AS deposit_count
       FROM deposits
       WHERE company_id = ? AND date >= ? AND date <= ?
       GROUP BY month
       ORDER BY month`,
      [company_id, startDate, endDate]
    );

    const mapSales = Object.fromEntries(salesByMonth.map(r => [r.month, r]));
    const mapCogs = Object.fromEntries(cogsByMonth.map(r => [r.month, r]));
    const mapBills = Object.fromEntries(billsByMonth.map(r => [r.month, r]));
    const mapExp = Object.fromEntries(expensesByMonth.map(r => [r.month, r]));
    const mapDep = Object.fromEntries(depositsByMonth.map(r => [r.month, r]));

    const series = [];
    let cursor = monthStart;
    while (cursor <= monthEnd) {
      const m = cursor.toFormat('yyyy-MM');
      const s = mapSales[m] || {};
      const d = mapDep[m] || {};
      const productNet = Number(s.subtotal || 0) + Number(s.shipping || 0) - Number(s.discount || 0);
      const depositIncome = Number(d.amount || 0);
      const netSales = productNet + depositIncome; // total income for charts
      const cogs = Number((mapCogs[m] && mapCogs[m].cogs) || 0);
      const opex = Number((mapBills[m] && mapBills[m].opex) || 0) + Number((mapExp[m] && mapExp[m].amount) || 0);
      const gross = netSales - cogs;
      const net = gross - opex;
      series.push({
        month: m,
        net_sales: netSales,
        product_net_sales: productNet,
        deposit_income: depositIncome,
        deposit_count: Number(d.deposit_count || 0),
        gross_receipts: Number(s.total || 0) + depositIncome,
        tax: Number(s.tax || 0),
        sale_count: Number(s.sale_count || 0),
        cogs,
        expenses: opex,
        gross_profit: gross,
        net_income: net,
      });
      cursor = cursor.plus({ months: 1 });
    }

    res.json({
      company_id,
      startDate,
      endDate,
      period: rangeMeta ? rangeMeta.period : (req.query.months ? `last_${req.query.months}_months` : 'last_12_months'),
      months: series,
    });
  } catch (err) {
    console.error('[API] /api/reports/trends error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Compact KPI bundle for summary "bubbles" on list pages.
 * One call → company-scoped MTD / YTD / open counts.
 */
app.get('/api/reports/kpis', async (req, res) => {
  try {
    const company_id = Number(req.query.company_id || 1);
    const zone = 'America/Los_Angeles';
    const now = DateTime.now().setZone(zone);
    const mtdStart = now.startOf('month').toFormat('yyyy-MM-dd');
    const ytdStart = now.startOf('year').toFormat('yyyy-MM-dd');
    const today = now.toFormat('yyyy-MM-dd');

    const [
      salesMtd, salesYtd, salesAll,
      billsUnpaid, billsPaid, billsMtd,
      depositsMtd, depositsYtd, depositsAll,
      expensesMtd, expensesYtd,
      customers, products, vendors,
      poByStatus, invoicesByStatus, estimatesByStatus,
      packing, lastSale, lastDeposit,
    ] = await Promise.all([
      dbGet(
        `SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total, COALESCE(SUM(tax),0) AS tax
         FROM sales WHERE company_id=? AND date>=? AND date<=?`,
        [company_id, mtdStart, today]
      ),
      dbGet(
        `SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total, COALESCE(SUM(tax),0) AS tax
         FROM sales WHERE company_id=? AND date>=? AND date<=?`,
        [company_id, ytdStart, today]
      ),
      dbGet(
        `SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total FROM sales WHERE company_id=?`,
        [company_id]
      ),
      dbGet(
        `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM bills
         WHERE company_id=? AND (paid IS NULL OR paid=0)`,
        [company_id]
      ),
      dbGet(
        `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM bills
         WHERE company_id=? AND paid=1`,
        [company_id]
      ),
      dbGet(
        `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM bills
         WHERE company_id=? AND bill_date>=? AND bill_date<=?`,
        [company_id, mtdStart, today]
      ),
      dbGet(
        `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM deposits
         WHERE company_id=? AND date>=? AND date<=?`,
        [company_id, mtdStart, today]
      ),
      dbGet(
        `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM deposits
         WHERE company_id=? AND date>=? AND date<=?`,
        [company_id, ytdStart, today]
      ),
      dbGet(
        `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM deposits WHERE company_id=?`,
        [company_id]
      ),
      dbGet(
        `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM expenses
         WHERE company_id=? AND date>=? AND date<=?`,
        [company_id, mtdStart, today]
      ),
      dbGet(
        `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM expenses
         WHERE company_id=? AND date>=? AND date<=?`,
        [company_id, ytdStart, today]
      ),
      dbGet(`SELECT COUNT(*) AS n FROM customers WHERE company_id=?`, [company_id]),
      dbGet(
        `SELECT COUNT(*) AS n,
                COALESCE(SUM(COALESCE(stock,0)),0) AS units,
                COALESCE(SUM(COALESCE(stock,0)*COALESCE(wholesale_price,0)),0) AS cost_value,
                COALESCE(SUM(CASE WHEN COALESCE(stock,0)<=0 THEN 1 ELSE 0 END),0) AS out_of_stock,
                COALESCE(SUM(CASE WHEN COALESCE(stock,0)>0 AND COALESCE(stock,0)<=5 THEN 1 ELSE 0 END),0) AS low_stock
         FROM products WHERE company_id=?`,
        [company_id]
      ),
      dbGet(`SELECT COUNT(*) AS n FROM vendors WHERE company_id=?`, [company_id]),
      dbAll(
        `SELECT COALESCE(status,'Unknown') AS status, COUNT(*) AS n
         FROM purchase_orders WHERE company_id=? GROUP BY status`,
        [company_id]
      ),
      dbAll(
        `SELECT COALESCE(status,'Unknown') AS status, COUNT(*) AS n,
                COALESCE(SUM(total),0) AS total
         FROM invoices WHERE company_id=? GROUP BY status`,
        [company_id]
      ),
      dbAll(
        `SELECT COALESCE(status,'Unknown') AS status, COUNT(*) AS n,
                COALESCE(SUM(total),0) AS total
         FROM estimates WHERE company_id=? GROUP BY status`,
        [company_id]
      ),
      dbGet(
        `SELECT COUNT(*) AS n FROM packing_slips WHERE company_id=?`,
        [company_id]
      ).catch(() => ({ n: 0 })),
      dbGet(
        `SELECT date, total, transaction_number FROM sales
         WHERE company_id=? ORDER BY date DESC, id DESC LIMIT 1`,
        [company_id]
      ),
      dbGet(
        `SELECT date, amount, description FROM deposits
         WHERE company_id=? ORDER BY date DESC, id DESC LIMIT 1`,
        [company_id]
      ),
    ]);

    const poMap = Object.fromEntries((poByStatus || []).map(r => [r.status, Number(r.n)]));
    const invMap = {};
    let invOpenAmt = 0;
    let invOpenN = 0;
    // Closed = paid / converted-to-sale / void (Convert used "Converted"; Pay uses "Paid")
    const invClosed = new Set(['paid', 'converted', 'void', 'cancelled', 'canceled']);
    (invoicesByStatus || []).forEach(r => {
      invMap[r.status] = { n: Number(r.n), total: Number(r.total) };
      if (!invClosed.has(String(r.status || '').toLowerCase())) {
        invOpenN += Number(r.n);
        invOpenAmt += Number(r.total);
      }
    });
    const estMap = {};
    let estOpenAmt = 0;
    (estimatesByStatus || []).forEach(r => {
      estMap[r.status] = { n: Number(r.n), total: Number(r.total) };
      if (String(r.status).toLowerCase() === 'pending' || String(r.status).toLowerCase() === 'open') {
        estOpenAmt += Number(r.total);
      }
    });

    const poOpen = (poMap.Pending || 0) + (poMap.pending || 0) + (poMap.Approved || 0) + (poMap.approved || 0);
    const poReceived = (poMap.received || 0) + (poMap.Received || 0);

    res.json({
      company_id,
      as_of: today,
      mtd_start: mtdStart,
      ytd_start: ytdStart,
      sales: {
        mtd_count: Number(salesMtd.n || 0),
        mtd_total: Number(salesMtd.total || 0),
        mtd_tax: Number(salesMtd.tax || 0),
        ytd_count: Number(salesYtd.n || 0),
        ytd_total: Number(salesYtd.total || 0),
        ytd_tax: Number(salesYtd.tax || 0),
        all_count: Number(salesAll.n || 0),
        all_total: Number(salesAll.total || 0),
        avg_mtd: Number(salesMtd.n) > 0 ? Number(salesMtd.total) / Number(salesMtd.n) : 0,
        last: lastSale || null,
      },
      bills: {
        unpaid_count: Number(billsUnpaid.n || 0),
        unpaid_total: Number(billsUnpaid.total || 0),
        paid_count: Number(billsPaid.n || 0),
        paid_total: Number(billsPaid.total || 0),
        mtd_count: Number(billsMtd.n || 0),
        mtd_total: Number(billsMtd.total || 0),
      },
      deposits: {
        mtd_count: Number(depositsMtd.n || 0),
        mtd_total: Number(depositsMtd.total || 0),
        ytd_count: Number(depositsYtd.n || 0),
        ytd_total: Number(depositsYtd.total || 0),
        all_count: Number(depositsAll.n || 0),
        all_total: Number(depositsAll.total || 0),
        last: lastDeposit || null,
      },
      expenses: {
        mtd_count: Number(expensesMtd.n || 0),
        mtd_total: Number(expensesMtd.total || 0),
        ytd_count: Number(expensesYtd.n || 0),
        ytd_total: Number(expensesYtd.total || 0),
      },
      customers: { count: Number(customers.n || 0) },
      products: {
        count: Number(products.n || 0),
        units: Number(products.units || 0),
        cost_value: Number(products.cost_value || 0),
        out_of_stock: Number(products.out_of_stock || 0),
        low_stock: Number(products.low_stock || 0),
      },
      vendors: { count: Number(vendors.n || 0) },
      purchase_orders: {
        by_status: poMap,
        open: poOpen,
        received: poReceived,
        total: Object.values(poMap).reduce((a, b) => a + b, 0),
      },
      invoices: {
        by_status: invMap,
        open_count: invOpenN,
        open_total: invOpenAmt,
        total_count: (invoicesByStatus || []).reduce((a, r) => a + Number(r.n), 0),
      },
      estimates: {
        by_status: estMap,
        open_value: estOpenAmt,
        total_count: (estimatesByStatus || []).reduce((a, r) => a + Number(r.n), 0),
      },
      packing_slips: { count: Number((packing && packing.n) || 0) },
      // Combined "income this month" for dual-mode companies
      income_mtd: Number(salesMtd.total || 0) + Number(depositsMtd.total || 0),
      income_ytd: Number(salesYtd.total || 0) + Number(depositsYtd.total || 0),
    });
  } catch (err) {
    console.error('[API] /api/reports/kpis error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** Top customers / products for the period */
app.get('/api/reports/top', async (req, res) => {
  try {
    const company_id = Number(req.query.company_id || 1);
    const range = resolveReportRange(req.query);
    const limit = Math.min(50, Math.max(5, Number(req.query.limit || 10)));
    const { startDate, endDate } = range;

    const customers = await dbAll(
      `SELECT COALESCE(c.name, s.customer_name, 'Unknown') AS name,
              COUNT(*) AS sale_count,
              COALESCE(SUM(s.total), 0) AS total
       FROM sales s
       LEFT JOIN customers c ON s.customer_id = c.id
       WHERE s.company_id = ? AND s.date >= ? AND s.date <= ?
       GROUP BY name
       ORDER BY total DESC
       LIMIT ?`,
      [company_id, startDate, endDate, limit]
    );

    const products = await dbAll(
      `SELECT COALESCE(p.name, 'Unknown') AS name,
              COALESCE(p.sku, '') AS sku,
              COALESCE(SUM(si.quantity), 0) AS qty,
              COALESCE(SUM(si.quantity * COALESCE(si.custom_price, p.retail_price, 0)), 0) AS revenue,
              COALESCE(SUM(si.quantity * COALESCE(si.wholesale_price, p.wholesale_price, 0)), 0) AS cogs
       FROM sale_items si
       INNER JOIN sales s ON s.id = si.transaction_id
       LEFT JOIN products p ON p.id = si.product_id
       WHERE s.company_id = ? AND s.date >= ? AND s.date <= ?
       GROUP BY p.id
       ORDER BY revenue DESC
       LIMIT ?`,
      [company_id, startDate, endDate, limit]
    );

    res.json({
      company_id,
      range,
      top_customers: customers,
      top_products: products.map(p => ({
        ...p,
        profit: Number(p.revenue || 0) - Number(p.cogs || 0),
      })),
    });
  } catch (err) {
    console.error('[API] /api/reports/top error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// Books / full ledger module (checks, assets, loans, tax, draws)
registerBooksRoutes(app, db);
// Optional EasyCart import
registerEasycartRoutes(app, db);
// Multi-company branding + tax/payment/feature settings
registerCompanyRoutes(app, db);

// Static Middleware and Routes
app.use('/uploads', express.static(appConfig.uploadDir));
app.use(express.static(path.join(__dirname, '..', 'client')));
app.get('/libs/chart.js', (req, res) => {
  console.log('GET /libs/chart.js');
  res.sendFile(path.join(__dirname, '../client/libs/chart.js'));
});
app.get('/libs/react-chartjs-2.js', (req, res) => {
  console.log('GET /libs/react-chartjs-2.js');
  res.sendFile(path.join(__dirname, '../client/libs/react-chartjs-2.js'));
});
app.get('/sales', (req, res) => {
  console.log('Handling /sales request');
  res.set({
    'Content-Type': 'text/html',
    'Content-Disposition': 'inline'
  });
  const filePath = path.join(__dirname, '../client', 'sales.html');
  console.log('Serving file:', filePath);
  res.sendFile(filePath, (err) => {
    if (err) {
      console.error('Error serving sales.html:', err);
      res.status(500).send('Error loading page');
    } else {
      console.log('Successfully served sales.html');
    }
  });
});
app.get('/', (req, res) => {
  console.log('GET /');
  res.sendFile(path.join(__dirname, '../client/index.html'));
});
app.get('/vendors', (req, res) => {
  console.log('GET /vendors');
  res.sendFile(path.join(__dirname, '../client/vendors.html'));
});
app.get('/inventory', (req, res) => {
  console.log('GET /inventory');
  res.sendFile(path.join(__dirname, '../client/inventory.html'));
});
app.get('/deposits', (req, res) => {
  console.log('GET /deposits');
  res.sendFile(path.join(__dirname, '../client/deposits.html'));
});
app.get('/expenses', (req, res) => {
  console.log('GET /expenses');
  res.sendFile(path.join(__dirname, '../client/expenses.html'));
});
app.get('/add-vendor', (req, res) => {
  console.log('GET /add-vendor');
  res.sendFile(path.join(__dirname, '../client/add-vendor.html'));
});
app.get('/add-products', (req, res) => {
  console.log('GET /add-products');
  res.sendFile(path.join(__dirname, '../client/add-products.html'));
});
app.get('/api/purchase-order', (req, res) => {
  const companyId = req.query.company_id;
  console.log(`[API] GET /api/purchase-order called with company_id=${companyId}`);
  if (!companyId) {
    console.error('[API] Missing company_id parameter');
    return res.status(400).json({ error: 'company_id is required' });
  }
  const query = 'SELECT po.*, v.name as vendor_name FROM purchase_orders po LEFT JOIN vendors v ON po.vendor_id = v.id WHERE po.company_id = ?';
  db.all(query, [companyId], (err, rows) => {
    if (err) {
      console.error('[API] Error querying purchase_orders:', err.message);
      return res.status(500).json({ error: `Database error: ${err.message}` });
    }
    db.all('SELECT poi.*, p.name as product_name, p.sku FROM purchase_order_items poi LEFT JOIN products p ON poi.product_id = p.id WHERE poi.company_id = ?', [companyId], (err, items) => {
      if (err) {
        console.error('[API] Error querying purchase_order_items:', err.message);
        return res.status(500).json({ error: `Database error: ${err.message}` });
      }
      try {
        rows.forEach(po => {
          po.items = items.filter(item => item.purchase_order_id === po.id);
        });
        console.log(`[API] Returning ${rows.length} purchase orders`);
        res.json(rows);
      } catch (jsonErr) {
        console.error('[API] JSON serialization error:', jsonErr.message);
        res.status(500).json({ error: `Failed to serialize response: ${jsonErr.message}` });
      }
    });
  });
});

// GET all packing slips with items
app.get('/api/packing-slips', (req, res) => {
  const companyId = req.query.company_id || 1;
  db.all(
    'SELECT ps.*, c.name AS customer_name FROM packing_slips ps LEFT JOIN customers c ON ps.customer_id = c.id WHERE ps.company_id = ? ORDER BY ps.date_shipped DESC',
    [companyId],
    (err, slips) => {
      if (err) return res.status(500).json({ error: err.message });
      db.all(
        'SELECT psi.*, p.sku, p.name AS product_name FROM packing_slip_items psi LEFT JOIN products p ON psi.product_id = p.id WHERE psi.company_id = ?',
        [companyId],
        (err, items) => {
          if (err) return res.status(500).json({ error: err.message });
          slips.forEach(slip => {
            slip.items = items.filter(i => i.packing_slip_id === slip.id);
          });
          res.json(slips);
        }
      );
    }
  );
});

// POST create new packing slip (items may include box_number for multi-box packs)
app.post('/api/packing-slips', (req, res) => {
  console.log('[PACKING POST] Full request body:', JSON.stringify(req.body, null, 2));
  console.log('[PACKING POST] Query params:', req.query);
  const {
    slip_number,
    customer_id,
    customer_po,
    date_shipped,
    shipping_address,
    notes,
    items,
    company_id = 1,
    invoice_id = null,
    sale_id = null,
    tracking_number = null
  } = req.body;
  if (!slip_number || !customer_id || !date_shipped || !items || items.length === 0) {
    return res.status(400).json({ error: 'Missing required fields: slip_number, customer_id, date_shipped, items' });
  }
  for (const item of items) {
    if (!item.product_id || !item.quantity) {
      return res.status(400).json({ error: 'Each item needs product_id and quantity' });
    }
  }
  // Unify ship-to: explicit slip address → customer shipping → billing
  db.get('SELECT shipping_address, billing_address FROM customers WHERE id = ? AND company_id = ?', [customer_id, company_id], (custErr, custRow) => {
    if (custErr) return res.status(500).json({ error: custErr.message });
    const resolvedShip = resolveShipTo({
      override: shipping_address,
      customer_shipping: custRow && custRow.shipping_address,
      customer_billing: custRow && custRow.billing_address
    }) || null;
  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    db.run(
      'INSERT INTO packing_slips (slip_number, customer_id, customer_po, date_shipped, shipping_address, notes, tracking_number, company_id, invoice_id, sale_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        slip_number,
        customer_id,
        customer_po || null,
        date_shipped,
        resolvedShip,
        notes || null,
        tracking_number || req.body.tracking_number || null,
        company_id,
        invoice_id || null,
        sale_id || null
      ],
      function(err) {
        if (err) {
          db.run('ROLLBACK');
          return res.status(500).json({ error: err.message });
        }
        const slipId = this.lastID;
        const stmt = db.prepare(
          'INSERT INTO packing_slip_items (packing_slip_id, product_id, quantity, company_id, box_number) VALUES (?, ?, ?, ?, ?)'
        );
        items.forEach(item => {
          // box_number 0 = backordered (not in a shipping box); 1+ = box N
          let boxNum = parseInt(item.box_number, 10);
          if (!Number.isFinite(boxNum) || boxNum < 0) boxNum = 1;
          stmt.run(slipId, item.product_id, item.quantity, company_id, boxNum);
        });
        stmt.finalize(err => {
          if (err) {
            db.run('ROLLBACK');
            return res.status(500).json({ error: err.message });
          }
          db.run('COMMIT');
          db.get(
            'SELECT ps.*, c.name AS customer_name FROM packing_slips ps LEFT JOIN customers c ON ps.customer_id = c.id WHERE ps.id = ?',
            [slipId],
            (err, slip) => {
              if (err || !slip) {
                return res.status(500).json({ error: (err && err.message) || 'Failed to fetch slip' });
              }
              db.all(
                'SELECT psi.*, p.sku, p.name AS product_name FROM packing_slip_items psi LEFT JOIN products p ON psi.product_id = p.id WHERE psi.packing_slip_id = ? ORDER BY CASE WHEN psi.box_number = 0 THEN 9999 ELSE psi.box_number END, psi.id',
                [slipId],
                (err, items) => {
                  slip.items = items || [];
                  res.status(201).json(slip);
                }
              );
            }
          );
        });
      }
    );
  });
  }); // end db.get customer for ship-to
});

app.get('/packing-slip.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/packing-slip.html'));
});

// Update existing packing slip (supports multi-box items via box_number)
app.put('/api/packing-slips/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const company_id = parseInt(req.query.company_id) || 1;

  const {
    slip_number,
    customer_id,
    customer_po,
    date_shipped,
    shipping_address,
    notes,
    tracking_number,
    invoice_id,
    items
  } = req.body;

  if (!id || isNaN(id)) {
    return res.status(400).json({ error: 'Invalid packing slip ID' });
  }

  if (!customer_id || !date_shipped || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');

    db.run(
      `UPDATE packing_slips
       SET slip_number       = ?,
           customer_id       = ?,
           customer_po       = ?,
           date_shipped      = ?,
           shipping_address  = ?,
           notes             = ?,
           tracking_number   = ?,
           invoice_id        = COALESCE(?, invoice_id),
           company_id        = ?
       WHERE id = ? AND company_id = ?`,
      [
        slip_number || null,
        customer_id,
        customer_po || null,
        date_shipped,
        shipping_address || null,
        notes || null,
        tracking_number || null,
        invoice_id != null ? invoice_id : null,
        company_id,
        id,
        company_id
      ],
      function (err) {
        if (err) {
          db.run('ROLLBACK');
          return res.status(500).json({ error: err.message });
        }

        if (this.changes === 0) {
          db.run('ROLLBACK');
          return res.status(404).json({ error: 'Packing slip not found' });
        }

        db.run(
          'DELETE FROM packing_slip_items WHERE packing_slip_id = ? AND company_id = ?',
          [id, company_id],
          (err) => {
            if (err) {
              db.run('ROLLBACK');
              return res.status(500).json({ error: err.message });
            }

            const stmt = db.prepare(
              'INSERT INTO packing_slip_items (packing_slip_id, product_id, quantity, company_id, box_number) VALUES (?, ?, ?, ?, ?)'
            );

            let hasError = false;
            for (const item of items) {
              let boxNum = parseInt(item.box_number, 10);
              if (!Number.isFinite(boxNum) || boxNum < 0) boxNum = 1;
              stmt.run(id, item.product_id, item.quantity, company_id, boxNum, (err) => {
                if (err) {
                  hasError = true;
                }
              });
            }

            stmt.finalize((err) => {
              if (err || hasError) {
                db.run('ROLLBACK');
                return res.status(500).json({ error: 'Failed to update items' });
              }

              db.run('COMMIT');

              db.get(
                `SELECT ps.*, c.name AS customer_name
                 FROM packing_slips ps
                 LEFT JOIN customers c ON ps.customer_id = c.id
                 WHERE ps.id = ? AND ps.company_id = ?`,
                [id, company_id],
                (err, slip) => {
                  if (err || !slip) {
                    return res.status(500).json({ error: 'Failed to fetch updated slip' });
                  }

                  db.all(
                    `SELECT psi.*, p.sku, p.name AS product_name
                     FROM packing_slip_items psi
                     LEFT JOIN products p ON psi.product_id = p.id
                     WHERE psi.packing_slip_id = ?
                     ORDER BY CASE WHEN psi.box_number = 0 THEN 9999 ELSE psi.box_number END, psi.id`,
                    [id],
                    (err, items) => {
                      slip.items = items || [];
                      res.json(slip);
                    }
                  );
                }
              );
            });
          }
        );
      }
    );
  });
});

// DELETE a packing slip
app.delete('/api/packing-slips/:id', (req, res) => {
  const { id } = req.params;
  const companyId = req.query.company_id || 1;
  console.log(`[API] DELETE /api/packing-slips/${id} called with company_id=${companyId}`);

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');

    // Delete items first
    db.run('DELETE FROM packing_slip_items WHERE packing_slip_id = ? AND company_id = ?', [id, companyId], err => {
      if (err) {
        console.error('[API] Error deleting packing_slip_items:', err.message);
        db.run('ROLLBACK');
        return res.status(500).json({ error: err.message });
      }

      // Then delete the slip
      db.run('DELETE FROM packing_slips WHERE id = ? AND company_id = ?', [id, companyId], function(err) {
        if (err) {
          console.error('[API] Error deleting packing_slip:', err.message);
          db.run('ROLLBACK');
          return res.status(500).json({ error: err.message });
        }
        if (this.changes === 0) {
          console.error('[API] Packing slip not found for id:', id);
          db.run('ROLLBACK');
          return res.status(404).json({ error: 'Packing slip not found' });
        }

        db.run('COMMIT', err => {
          if (err) {
            console.error('[API] Commit failed:', err.message);
            return res.status(500).json({ error: err.message });
          }
          console.log(`[API] Successfully deleted packing slip ${id}`);
          res.status(204).send();
        });
      });
    });
  });
});

app.get('/transaction-history', (req, res) => {
  console.log('GET /transaction-history');
  res.sendFile(path.join(__dirname, '../client/transaction-history.html'));
});
app.get('/customer-list', (req, res) => {
  console.log('GET /customer-list');
  res.sendFile(path.join(__dirname, '../client/customer-list.html'));
});
app.get('/receive-inventory', (req, res) => {
  console.log('GET /receive-inventory');
  res.sendFile(path.join(__dirname, '../client/receive-inventory.html'));
});
app.get('/bills', (req, res) => {
  console.log('GET /bills');
  res.sendFile(path.join(__dirname, '../client/bills.html'));
});
app.get('/sales-tax', (req, res) => {
  console.log('GET /sales-tax');
  res.set({ 'Content-Type': 'text/html', 'Content-Disposition': 'inline' });
  res.sendFile(path.join(__dirname, '../client/sales-tax.html'));
});
app.get('/estimates', (req, res) => {
  console.log('GET /estimates');
  res.set({ 'Content-Type': 'text/html', 'Content-Disposition': 'inline' });
  res.sendFile(path.join(__dirname, '../client/estimates.html'));
});
app.get('/invoices', (req, res) => {
  console.log('GET /invoices');
  res.set({ 'Content-Type': 'text/html', 'Content-Disposition': 'inline' });
  res.sendFile(path.join(__dirname, '../client/invoices.html'));
});
app.get('/books', (req, res) => {
  res.set({ 'Content-Type': 'text/html', 'Content-Disposition': 'inline' });
  res.sendFile(path.join(__dirname, '../client/books.html'));
});
app.get('/books.html', (req, res) => {
  res.set({ 'Content-Type': 'text/html', 'Content-Disposition': 'inline' });
  res.sendFile(path.join(__dirname, '../client/books.html'));
});
app.get('/wpeasycart-import', (req, res) => {
  res.set({ 'Content-Type': 'text/html', 'Content-Disposition': 'inline' });
  res.sendFile(path.join(__dirname, '../client/wpeasycart-import.html'));
});
app.get('/wpeasycart-import.html', (req, res) => {
  res.set({ 'Content-Type': 'text/html', 'Content-Disposition': 'inline' });
  res.sendFile(path.join(__dirname, '../client/wpeasycart-import.html'));
});
app.get('/catalog-home', (req, res) => {
  console.log('GET /catalog-home');
  res.set({ 'Content-Type': 'text/html', 'Content-Disposition': 'inline' });
  res.sendFile(path.join(__dirname, '../client/catalog-home.html'));
});
app.get('/services-home', (req, res) => {
  console.log('GET /services-home');
  res.set({ 'Content-Type': 'text/html', 'Content-Disposition': 'inline' });
  res.sendFile(path.join(__dirname, '../client/services-home.html'));
});
app.get('/services-reports', (req, res) => {
  console.log('GET /services-reports');
  res.set({ 'Content-Type': 'text/html', 'Content-Disposition': 'inline' });
  res.sendFile(path.join(__dirname, '../client/services-reports.html'));
});
// Branding upload — logo or favicon (field name "logo" kept for FormData compatibility)
// body.kind = "logo" | "favicon"
app.post('/api/settings/logo', upload.single('logo'), (req, res) => {
  console.log('POST /api/settings/logo', req.file && req.file.filename, 'kind=', req.body && req.body.kind);
  if (!req.file) {
    console.error('No file uploaded');
    return res.status(400).json({ error: 'No file uploaded' });
  }
  const publicPath = '/uploads/' + req.file.filename;
  const companyId = parseInt(req.body.company_id || req.query.company_id || '0', 10) || null;
  const kind = String(req.body.kind || 'logo').toLowerCase() === 'favicon' ? 'favicon' : 'logo';
  const payload = {
    success: true,
    message: (kind === 'favicon' ? 'Favicon' : 'Logo') + ' uploaded successfully',
    company_id: companyId,
    filename: req.file.filename,
    kind,
  };
  if (kind === 'favicon') payload.favicon_path = publicPath;
  else payload.logo_path = publicPath;
  // Always include both keys for simpler clients
  payload.path = publicPath;
  res.json(payload);
});
// Reports Page (index.html)
const reportsPageContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reports - My Company</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="/libs/chart.js"></script>
  <script src="/libs/react-chartjs-2.js"></script>
  <script src="https://unpkg.com/react@17/umd/react.production.min.js"></script>
  <script src="https://unpkg.com/react-dom@17/umd/react-dom.production.min.js"></script>
  <script src="https://unpkg.com/babel-standalone@6/babel.min.js"></script>
</head>
<body class="bg-gray-100 font-sans">
  <div id="root" class="container mx-auto p-4"></div>
  <script type="text/babel">
    const { useState, useEffect } = React;
    const Reports = () => {
      const [salesData, setSalesData] = useState([]);
      const [billsData, setBillsData] = useState([]);
      const [inventorySnapshots, setInventorySnapshots] = useState([]);
      const [period, setPeriod] = useState('monthly');
      const [startDate, setStartDate] = useState('');
      const [endDate, setEndDate] = useState('');
      const companyId = 1;
      useEffect(() => {
        fetchData();
      }, [period, startDate, endDate]);
      const fetchData = async () => {
        try {
          const salesQuery = startDate && endDate
            ? \`/api/reports/sales?company_id=\${companyId}&startDate=\${startDate}&endDate=\${endDate}\`
            : \`/api/reports/sales?company_id=\${companyId}&period=\${period}\`;
          const billsQuery = startDate && endDate
            ? \`/api/reports/bills?company_id=\${companyId}&startDate=\${startDate}&endDate=\${endDate}\`
            : \`/api/reports/bills?company_id=\${companyId}&period=\${period}\`;
         
          const [salesRes, billsRes, snapshotsRes] = await Promise.all([
            fetch(salesQuery).then(res => res.json()),
            fetch(billsQuery).then(res => res.json()),
            fetch(\`/api/inventory_snapshots?company_id=\${companyId}\`).then(res => res.json())
          ]);
          setSalesData(salesRes);
          setBillsData(billsRes);
          setInventorySnapshots(snapshotsRes);
        } catch (error) {
          console.error('Error fetching data:', error);
        }
      };
      const filterData = (data, dateField, isInventory = false, isFreight = false, periodOverride = null, excludeFreight = false) => {
        const now = new Date();
        let filteredData = data;
        if (excludeFreight) {
          filteredData = filteredData.filter(item => !item.is_inventory_bill);
        }
        if (isFreight) {
          filteredData = filteredData.filter(item => item.is_inventory_bill);
        }
        if (periodOverride || period) {
          const selectedPeriod = periodOverride || period;
          const start = new Date();
          if (selectedPeriod === 'daily') start.setDate(now.getDate());
          else if (selectedPeriod === 'weekly') start.setDate(now.getDate() - 7);
          else if (selectedPeriod === 'monthly') start.setMonth(now.getMonth() - 1);
          else if (selectedPeriod === 'yearly') start.setFullYear(now.getFullYear() - 1);
          filteredData = filteredData.filter(item => new Date(item[dateField]) >= start);
        }
        if (startDate && endDate) {
          filteredData = filteredData.filter(
            item => new Date(item[dateField]) >= new Date(startDate) && new Date(item[dateField]) <= new Date(endDate)
          );
        }
        return filteredData;
      };
      const calculateMetrics = () => {
        const filteredSales = filterData(salesData, 'date');
        const filteredBills = filterData(billsData, 'bill_date', false, false, null, true);
        const freightBills = filterData(billsData, 'bill_date', false, true);
        const totalSales = filteredSales.reduce((sum, sale) => sum + sale.total, 0);
        const totalCOGS = filteredSales.reduce((sum, sale) =>
          sum + (sale.items?.reduce((itemSum, item) => itemSum + item.cogs, 0) || 0), 0);
        const totalExpenses = filteredBills.reduce((sum, bill) => sum + bill.amount, 0);
        const totalFreight = freightBills.reduce((sum, bill) => sum + bill.amount, 0);
        const grossProfit = totalSales - totalCOGS;
        const netProfit = grossProfit - totalExpenses - totalFreight;
        return { totalSales, totalCOGS, grossProfit, totalExpenses, totalFreight, netProfit };
      };
      const { totalSales, totalCOGS, grossProfit, totalExpenses, totalFreight, netProfit } = calculateMetrics();
      const salesByProduct = () => {
        const productMap = {};
        filterData(salesData, 'date').forEach(sale => {
          sale.items?.forEach(item => {
            if (!productMap[item.product_name]) {
              productMap[item.product_name] = { total: 0, cogs: 0 };
            }
            productMap[item.product_name].total += item.quantity * (item.custom_price || item.retail_price);
            productMap[item.product_name].cogs += item.cogs;
          });
        });
        return {
          labels: Object.keys(productMap),
          datasets: [
            {
              label: 'Sales',
              data: Object.values(productMap).map(p => p.total),
              backgroundColor: 'rgba(54, 162, 235, 0.5)',
            },
            {
              label: 'COGS',
              data: Object.values(productMap).map(p => p.cogs),
              backgroundColor: 'rgba(255, 99, 132, 0.5)',
            }
          ]
        };
      };
      const chartOptions = {
        responsive: true,
        plugins: {
          legend: { position: 'top' },
          title: { display: true, text: 'Sales by Product' }
        },
        scales: {
          y: { beginAtZero: true, title: { display: true, text: 'Amount ($)' } }
        }
      };
      return (
        <div className="bg-white p-6 rounded-lg shadow-md">
          <h1 className="text-2xl font-bold mb-4">Financial Reports</h1>
         
          <div className="mb-4 flex space-x-4">
            <select
              value={period}
              onChange={e => { setPeriod(e.target.value); setStartDate(''); setEndDate(''); }}
              className="p-2 border rounded"
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
            </select>
            <input
              type="date"
              value={startDate}
              onChange={e => { setStartDate(e.target.value); setPeriod(''); }}
              className="p-2 border rounded"
              placeholder="Start Date"
            />
            <input
              type="date"
              value={endDate}
              onChange={e => { setEndDate(e.target.value); setPeriod(''); }}
              className="p-2 border rounded"
              placeholder="End Date"
            />
          </div>
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div className="p-4 bg-blue-100 rounded">
              <h2 className="text-lg font-semibold">Total Sales</h2>
              <p>$\${totalSales.toFixed(2)}</p>
            </div>
            <div className="p-4 bg-red-100 rounded">
              <h2 className="text-lg font-semibold">Total COGS</h2>
              <p>$\${totalCOGS.toFixed(2)}</p>
            </div>
            <div className="p-4 bg-green-100 rounded">
              <h2 className="text-lg font-semibold">Gross Profit</h2>
              <p>$\${grossProfit.toFixed(2)}</p>
            </div>
            <div className="p-4 bg-yellow-100 rounded">
              <h2 className="text-lg font-semibold">Total Expenses</h2>
              <p>$\${totalExpenses.toFixed(2)}</p>
            </div>
            <div className="p-4 bg-purple-100 rounded">
              <h2 className="text-lg font-semibold">Total Freight</h2>
              <p>$\${totalFreight.toFixed(2)}</p>
            </div>
            <div className="p-4 bg-indigo-100 rounded">
              <h2 className="text-lg font-semibold">Net Profit</h2>
              <p>$\${netProfit.toFixed(2)}</p>
            </div>
          </div>
          <div className="mb-4">
            <h2 className="text-lg font-semibold mb-2">Sales by Product</h2>
            <Bar data={salesByProduct()} options={chartOptions} />
          </div>
          <div>
            <h2 className="text-lg font-semibold mb-2">Inventory Snapshots</h2>
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-gray-200">
                  <th className="p-2 border">Date</th>
                  <th className="p-2 border">Total Value</th>
                </tr>
              </thead>
              <tbody>
                {inventorySnapshots.map(snapshot => (
                  <tr key={snapshot.id}>
                    <td className="p-2 border">{new Date(snapshot.snapshot_date).toLocaleDateString()}</td>
                    <td className="p-2 border">$\${snapshot.total_value.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    };
    const Bar = window.ChartJS.Bar;
    ReactDOM.render(<Reports />, document.getElementById('root'));
  </script>
</body>
</html>
`;
// Serve Reports Page
app.get('/reports', (req, res) => {
  console.log('GET /reports');
  res.set({
    'Content-Type': 'text/html',
    'Content-Disposition': 'inline'
  });
  res.send(reportsPageContent);
});

// Fix code-server proxy paths
app.use('/proxy/3003', (req, res, next) => {
  req.url = req.url.replace(/^\/proxy\/3003/, '');
  next();
});
// GET ALL SALES
app.get('/api/sales', (req, res) => {
  const companyId = req.query.company_id || 1;
  db.all(
    `SELECT s.*, c.name as customer_name 
     FROM sales s 
     LEFT JOIN customers c ON s.customer_id = c.id 
     WHERE s.company_id = ? 
     ORDER BY s.date DESC`,
    [companyId],
    (err, rows) => {
      if (err) {
        console.error('[API] GET /api/sales error:', err.message);
        return res.status(500).json({ error: err.message });
      }
      res.json(rows || []);
    }
  );
});

// CUSTOMERS — safe version
app.get('/api/customers', (req, res) => {
  const companyId = req.query.company_id || 1;
  const timeout = setTimeout(() => res.status(504).json({ error: 'Timeout' }), 5000);
  db.all('SELECT * FROM customers WHERE company_id = ? ORDER BY name', [companyId], (err, rows) => {
    clearTimeout(timeout);
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// INVOICES — safe version
app.get('/api/invoices', (req, res) => {
  const companyId = req.query.company_id || 1;
  const timeout = setTimeout(() => res.status(504).json({ error: 'Timeout' }), 5000);
  db.all(
    `SELECT i.*, c.name as customer_name 
     FROM invoices i 
     LEFT JOIN customers c ON i.customer_id = c.id 
     WHERE i.company_id = ? 
     ORDER BY i.date DESC`,
    [companyId],
    (err, rows) => {
      clearTimeout(timeout);
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    }
  );
});

// PRODUCTS — safe version
app.get('/api/products', (req, res) => {
  const companyId = req.query.company_id || 1;
  const timeout = setTimeout(() => res.status(504).json({ error: 'Timeout' }), 5000);
  db.all('SELECT * FROM products WHERE company_id = ? ORDER BY name', [companyId], (err, rows) => {
    clearTimeout(timeout);
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});
// Global 404 Handler
app.use((req, res) => {
  console.error('[API] Route not found:', req.originalUrl);
  res.status(404).json({ error: 'Route not found' });
});
// Global Error Handler
app.use((err, req, res, next) => {
  console.error('[API] Server error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});
// Start Server
// THIS MUST BE THE LAST THING IN server_new.js
// Global Error Handler (keep this exactly as it is)
app.use((err, req, res, next) => {
  console.error('[API] Server error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server. HTTP by default. Set TLS_KEY and TLS_CERT to serve HTTPS.
const PORT = appConfig.port;
const HOST = appConfig.host;
if (appConfig.tlsKey && appConfig.tlsCert) {
  const https = require('https');
  const credentials = {
    key: fs.readFileSync(appConfig.tlsKey, 'utf8'),
    cert: fs.readFileSync(appConfig.tlsCert, 'utf8'),
  };
  https.createServer(credentials, app).listen(PORT, HOST, () => {
    console.log('Open Accounting listening on https://' + HOST + ':' + PORT);
  });
} else {
  app.listen(PORT, HOST, () => {
    console.log('Open Accounting listening on http://' + HOST + ':' + PORT);
  });
}
