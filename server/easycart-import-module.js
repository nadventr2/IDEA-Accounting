/**
 * WP EasyCart → Accounting import
 * Read-only from EasyCart MySQL; writes sales/customers/products into SQLite accounting.db
 */
const mysql = require('mysql2/promise');
const { DateTime } = require('luxon');
const ecConfig = require('./easycart-config');
const { normalizeTaxRate, rateFromTaxAmount } = require('./tax-rate');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}
function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}
function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

let pool = null;

function getPool() {
  if (!ecConfig.enabled) {
    const err = new Error('EasyCart is disabled. Set EASYCART_ENABLED=1 and the MySQL settings.');
    err.code = 'EASYCART_DISABLED';
    throw err;
  }
  if (!ecConfig.host || !ecConfig.user || !ecConfig.database) {
    const err = new Error('EasyCart MySQL settings are blank.');
    err.code = 'EASYCART_DISABLED';
    throw err;
  }
  if (!pool) {
    // Only pass mysql2 options — not productOwner / remote* keys
    pool = mysql.createPool({
      host: ecConfig.host,
      user: ecConfig.user,
      password: ecConfig.password,
      database: ecConfig.database,
      waitForConnections: ecConfig.waitForConnections !== false,
      connectionLimit: ecConfig.connectionLimit || 4,
      queueLimit: ecConfig.queueLimit || 0,
      dateStrings: ecConfig.dateStrings !== false,
      timezone: ecConfig.timezone || 'local',
    });
  }
  return pool;
}

function ensureColumn(db, table, column, typeSql) {
  db.all(`PRAGMA table_info(${table})`, (err, rows) => {
    if (err || !rows) return;
    if (!rows.some((r) => r.name === column)) {
      db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeSql}`, (e) => {
        if (e) console.warn(`[easycart] add column ${table}.${column}:`, e.message);
      });
    }
  });
}

function initEasycartSchema(db) {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS easycart_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      order_id INTEGER NOT NULL,
      sale_id INTEGER,
      import_mode TEXT NOT NULL DEFAULT 'full',
      subtotal REAL,
      tax REAL,
      shipping REAL,
      discount REAL,
      total REAL,
      notes TEXT,
      imported_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS easycart_import_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_id INTEGER NOT NULL,
      company_id INTEGER NOT NULL,
      order_id INTEGER NOT NULL,
      orderdetail_id INTEGER NOT NULL,
      sale_id INTEGER,
      UNIQUE(company_id, orderdetail_id)
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_ec_import_order ON easycart_imports(company_id, order_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_ec_import_lines_order ON easycart_import_lines(company_id, order_id)`);
    // Product description from EasyCart catalog
    ensureColumn(db, 'products', 'description', 'TEXT');
    // party_a | mark — who gets product proceeds for this sale
    ensureColumn(db, 'sales', 'product_owner', "TEXT DEFAULT 'party_b'");
    ensureColumn(db, 'easycart_imports', 'product_owner', "TEXT DEFAULT 'party_a'");
    ensureColumn(db, 'easycart_imports', 'settlement_id', 'INTEGER');
  });
}

function remitConfig() {
  const po = ecConfig.productOwner || {};
  return {
    cleanStartDate: po.cleanStartDate || '2026-08-01',
    feeRate: Number(po.feeRate != null ? po.feeRate : 0.035),
    importOwner: po.importOwner || 'party_a',
  };
}

/** Product proceeds base (exclude sales tax — tax stays with the company). */
function productBase(subtotal, shipping, discount) {
  return Math.max(
    0,
    Math.round((Number(subtotal || 0) + Number(shipping || 0) - Number(discount || 0)) * 100) / 100
  );
}

/** Amount remitted to principal after card fee. */
function remittanceAfterFee(base, feeRate) {
  const rate = Number(feeRate);
  const b = Number(base || 0);
  return Math.max(0, Math.round(b * (1 - rate) * 100) / 100);
}

/** Strip HTML from EasyCart product descriptions for plain-text storage */
function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function mapPaymentMethod(raw) {
  const p = String(raw || '').trim();
  const u = p.toUpperCase();
  if (!p) return 'Card';
  if (u === 'PAYPAL' || u.includes('PAYPAL')) return 'PayPal';
  if (['VISA', 'MASTERCARD', 'AMERICAN_EXPRESS', 'AMEX', 'DISCOVER', 'CREDIT', 'CARD'].includes(u)) {
    return 'Card';
  }
  if (u.includes('SQUARE')) return 'Square';
  if (u === 'CASH') return 'Cash';
  if (u === 'CHECK' || u === 'CHEQUE') return 'Check';
  // Keep readable label
  return p.replace(/_/g, ' ');
}

function formatAddress(parts) {
  return parts
    .map((x) => (x == null ? '' : String(x).trim()))
    .filter(Boolean)
    .join('\n');
}

function orderDateOnly(orderDate) {
  if (!orderDate) return DateTime.now().setZone('America/Los_Angeles').toFormat('yyyy-MM-dd');
  const s = String(orderDate).replace(' ', 'T');
  let dt = DateTime.fromISO(s, { zone: 'America/Los_Angeles' });
  if (!dt.isValid) dt = DateTime.fromSQL(String(orderDate), { zone: 'America/Los_Angeles' });
  if (!dt.isValid) dt = DateTime.fromJSDate(new Date(orderDate));
  return dt.isValid ? dt.toFormat('yyyy-MM-dd') : String(orderDate).slice(0, 10);
}

async function remoteFeedGet(pathAndQuery) {
  if (!ecConfig.remoteUrl) {
    throw new Error('EC_MODE=remote requires EC_REMOTE_URL (EasyCart feed base URL)');
  }
  if (!ecConfig.remotePassword) {
    throw new Error('EC_MODE=remote requires EC_REMOTE_PASSWORD');
  }
  const url = `${ecConfig.remoteUrl}${pathAndQuery.startsWith('/') ? '' : '/'}${pathAndQuery}`;
  const auth = Buffer.from(`${ecConfig.remoteUser}:${ecConfig.remotePassword}`).toString('base64');
  const https = require('https');
  const http = require('http');
  const lib = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.get(
      url,
      {
        headers: {
          Accept: 'application/json',
          Authorization: `Basic ${auth}`,
        },
        rejectUnauthorized: !ecConfig.remoteInsecureTls,
        timeout: 60000,
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let data = null;
          try {
            data = buf ? JSON.parse(buf) : null;
          } catch (_) {
            return reject(new Error(`EasyCart feed returned non-JSON (${res.statusCode})`));
          }
          if (res.statusCode === 401) {
            return reject(new Error('EasyCart feed: login failed (check EC_REMOTE_USER / EC_REMOTE_PASSWORD)'));
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error((data && data.error) || `EasyCart feed HTTP ${res.statusCode}`));
          }
          resolve(data);
        });
      }
    );
    req.on('error', (e) => reject(new Error(`EasyCart feed unreachable: ${e.message}`)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('EasyCart feed request timed out'));
    });
  });
}

async function getImportStatusMap(db, companyId, orderIds) {
  if (!orderIds.length) return {};
  if (!db) {
    const byOrder = {};
    for (const o of orderIds) {
      byOrder[o] = { imported_line_ids: [], import_count: 0, sale_ids: [] };
    }
    return byOrder;
  }
  const placeholders = orderIds.map(() => '?').join(',');
  const lines = await dbAll(
    db,
    `SELECT order_id, orderdetail_id FROM easycart_import_lines
     WHERE company_id = ? AND order_id IN (${placeholders})`,
    [companyId, ...orderIds]
  );
  const imports = await dbAll(
    db,
    `SELECT order_id, COUNT(*) AS n, GROUP_CONCAT(sale_id) AS sale_ids
     FROM easycart_imports WHERE company_id = ? AND order_id IN (${placeholders})
     GROUP BY order_id`,
    [companyId, ...orderIds]
  );
  const byOrder = {};
  for (const o of orderIds) {
    byOrder[o] = { imported_line_ids: [], import_count: 0, sale_ids: [] };
  }
  for (const row of lines) {
    if (!byOrder[row.order_id]) byOrder[row.order_id] = { imported_line_ids: [], import_count: 0, sale_ids: [] };
    byOrder[row.order_id].imported_line_ids.push(row.orderdetail_id);
  }
  for (const row of imports) {
    if (!byOrder[row.order_id]) byOrder[row.order_id] = { imported_line_ids: [], import_count: 0, sale_ids: [] };
    byOrder[row.order_id].import_count = row.n;
    byOrder[row.order_id].sale_ids = String(row.sale_ids || '')
      .split(',')
      .filter(Boolean)
      .map(Number);
  }
  return byOrder;
}

async function fetchOrders(opts = {}) {
  const {
    q = '',
    page = 1,
    limit = 50,
    from = null,
    to = null,
    status_id = null,
  } = opts;

  // Party B machine: pull order list from Party A secure feed API
  if (ecConfig.mode === 'remote') {
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('limit', String(limit));
    if (q) params.set('q', q);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (status_id != null && status_id !== '' && status_id !== 'all') {
      params.set('status_id', String(status_id));
    }
    const data = await remoteFeedGet(`/api/easycart/orders?${params.toString()}`);
    // Feed returns enriched rows; strip import_status so local DB can re-apply
    const orders = (data.orders || []).map((o) => ({
      ...o,
      // keep raw fields expected by local enricher
      order_id: o.order_id,
      order_date: o.order_date,
      orderstatus_id: o.orderstatus_id,
      order_status: o.order_status,
      sub_total: o.sub_total,
      tax_total: o.tax_total,
      shipping_total: o.shipping_total,
      discount_total: o.discount_total,
      grand_total: o.grand_total,
      payment_method: o.payment_method,
      user_email: o.user_email,
      billing_first_name: o.customer_name ? String(o.customer_name).split(' ')[0] : o.billing_first_name,
      billing_last_name: o.customer_name
        ? String(o.customer_name).split(' ').slice(1).join(' ')
        : o.billing_last_name,
      shipping_first_name: o.shipping_name ? String(o.shipping_name).split(' ')[0] : o.shipping_first_name,
      shipping_last_name: o.shipping_name
        ? String(o.shipping_name).split(' ').slice(1).join(' ')
        : o.shipping_last_name,
      billing_phone: o.phone || o.billing_phone,
      shipping_phone: o.phone || o.shipping_phone,
      line_count: o.line_count,
    }));
    return { total: data.total || orders.length, page: data.page || page, limit: data.limit || limit, orders };
  }

  const offset = (Math.max(1, page) - 1) * limit;
  const where = ['1=1'];
  const params = [];

  if (q && String(q).trim()) {
    const like = `%${String(q).trim()}%`;
    where.push(`(
      CAST(o.order_id AS CHAR) LIKE ? OR
      o.user_email LIKE ? OR
      o.billing_first_name LIKE ? OR
      o.billing_last_name LIKE ? OR
      o.shipping_first_name LIKE ? OR
      o.shipping_last_name LIKE ? OR
      o.billing_phone LIKE ? OR
      o.payment_method LIKE ? OR
      CONCAT(o.billing_first_name, ' ', o.billing_last_name) LIKE ? OR
      CONCAT(o.shipping_first_name, ' ', o.shipping_last_name) LIKE ?
    )`);
    for (let i = 0; i < 10; i++) params.push(like);
  }
  if (from) {
    where.push('DATE(o.order_date) >= ?');
    params.push(from);
  }
  if (to) {
    where.push('DATE(o.order_date) <= ?');
    params.push(to);
  }
  if (status_id != null && status_id !== '' && status_id !== 'all') {
    where.push('o.orderstatus_id = ?');
    params.push(Number(status_id));
  }

  const whereSql = where.join(' AND ');
  const pool = getPool();

  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM ec_order o WHERE ${whereSql}`,
    params
  );
  const total = Number(countRows[0]?.cnt || 0);

  const [rows] = await pool.query(
    `SELECT o.order_id, o.order_date, o.orderstatus_id, os.order_status,
            o.sub_total, o.tax_total, o.shipping_total, o.discount_total, o.grand_total,
            o.payment_method, o.user_email, o.billing_phone, o.shipping_phone,
            o.billing_first_name, o.billing_last_name, o.billing_company_name,
            o.shipping_first_name, o.shipping_last_name,
            o.tracking_number, o.order_gateway,
            (SELECT COUNT(*) FROM ec_orderdetail d WHERE d.order_id = o.order_id) AS line_count
     FROM ec_order o
     LEFT JOIN ec_orderstatus os ON os.status_id = o.orderstatus_id
     WHERE ${whereSql}
     ORDER BY o.order_id DESC
     LIMIT ? OFFSET ?`,
    [...params, Number(limit), Number(offset)]
  );

  return { total, page: Number(page), limit: Number(limit), orders: rows };
}

async function fetchOrderDetail(orderId) {
  if (ecConfig.mode === 'remote') {
    const data = await remoteFeedGet(`/api/easycart/orders/${orderId}?company_id=0`);
    // Rebuild { order, lines } shape expected by import / detail enrichers
    if (!data || !data.order) return null;
    const o = data.order;
    const order = {
      order_id: o.order_id,
      order_date: o.order_date || o.date,
      orderstatus_id: o.orderstatus_id,
      order_status: o.order_status,
      sub_total: o.sub_total,
      tax_total: o.tax_total,
      shipping_total: o.shipping_total,
      discount_total: o.discount_total,
      grand_total: o.grand_total,
      payment_method: o.payment_method,
      user_email: o.user_email,
      billing_first_name: (o.billing && o.billing.name ? o.billing.name.split(' ')[0] : '') || '',
      billing_last_name: (o.billing && o.billing.name ? o.billing.name.split(' ').slice(1).join(' ') : '') || '',
      billing_company_name: o.billing && o.billing.company,
      billing_phone: o.billing && o.billing.phone,
      billing_address_line_1: o.billing && o.billing.address ? String(o.billing.address).split('\n')[0] : '',
      billing_address_line_2: '',
      billing_city: '',
      billing_state: '',
      billing_zip: '',
      billing_country: '',
      shipping_first_name: (o.shipping && o.shipping.name ? o.shipping.name.split(' ')[0] : '') || '',
      shipping_last_name: (o.shipping && o.shipping.name ? o.shipping.name.split(' ').slice(1).join(' ') : '') || '',
      shipping_company_name: o.shipping && o.shipping.company,
      shipping_phone: o.shipping && o.shipping.phone,
      shipping_address_line_1: o.shipping && o.shipping.address ? String(o.shipping.address).split('\n')[0] : '',
      shipping_address_line_2: '',
      shipping_city: '',
      shipping_state: '',
      shipping_zip: '',
      shipping_country: '',
      tracking_number: o.tracking_number,
      order_notes: o.order_notes,
      order_customer_notes: o.customer_notes,
      // Keep structured addresses for findOrCreateCustomer via formatAddress if we patch order
      _billing_address_block: o.billing && o.billing.address,
      _shipping_address_block: o.shipping && o.shipping.address,
    };
    // Prefer full address blocks when creating customers
    if (order._billing_address_block) {
      const parts = String(order._billing_address_block).split('\n');
      order.billing_address_line_1 = parts[0] || '';
      order.billing_address_line_2 = parts[1] || '';
      order.billing_city = parts[2] || '';
    }
    if (order._shipping_address_block) {
      const parts = String(order._shipping_address_block).split('\n');
      order.shipping_address_line_1 = parts[0] || '';
      order.shipping_address_line_2 = parts[1] || '';
      order.shipping_city = parts[2] || '';
    }
    const lines = (data.lines || []).map((l) => ({
      orderdetail_id: l.orderdetail_id,
      product_id: l.product_id,
      model_number: l.model_number,
      title: l.title,
      quantity: l.quantity,
      unit_price: l.unit_price,
      total_price: l.total_price,
      product_description: l.description,
      catalog_price: l.catalog_price,
      product_cost: l.product_cost_hint,
      optionitem_name_1: l.options || '',
      optionitem_name_2: '',
      optionitem_name_3: '',
      optionitem_name_4: '',
      optionitem_name_5: '',
    }));
    return { order, lines };
  }

  const pool = getPool();
  const [orders] = await pool.query(
    `SELECT o.*, os.order_status
     FROM ec_order o
     LEFT JOIN ec_orderstatus os ON os.status_id = o.orderstatus_id
     WHERE o.order_id = ?`,
    [orderId]
  );
  if (!orders.length) return null;
  const order = orders[0];
  const [lines] = await pool.query(
    `SELECT d.*, p.model_number AS product_model, p.title AS product_title, p.price AS catalog_price,
            p.product_cost, p.manufacturer_id, p.description AS product_description,
            p.list_price AS catalog_list_price
     FROM ec_orderdetail d
     LEFT JOIN ec_product p ON p.product_id = d.product_id
     WHERE d.order_id = ?
     ORDER BY d.orderdetail_id ASC`,
    [orderId]
  );
  return { order, lines };
}

async function listStatuses() {
  if (ecConfig.mode === 'remote') {
    return remoteFeedGet('/api/easycart/statuses');
  }
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT status_id, order_status, is_approved
     FROM ec_orderstatus
     ORDER BY status_id`
  );
  return rows;
}

async function findOrCreateCustomer(db, companyId, order) {
  const email = (order.user_email || '').trim().toLowerCase();
  const name = [order.billing_first_name, order.billing_last_name].filter(Boolean).join(' ').trim()
    || [order.shipping_first_name, order.shipping_last_name].filter(Boolean).join(' ').trim()
    || email
    || `EC Customer ${order.order_id}`;
  const phone = (order.billing_phone || order.shipping_phone || '').trim();
  const billing = formatAddress([
    order.billing_company_name,
    [order.billing_first_name, order.billing_last_name].filter(Boolean).join(' '),
    order.billing_address_line_1,
    order.billing_address_line_2,
    [order.billing_city, order.billing_state, order.billing_zip].filter(Boolean).join(', '),
    order.billing_country,
  ]);
  const shipping = formatAddress([
    order.shipping_company_name,
    [order.shipping_first_name, order.shipping_last_name].filter(Boolean).join(' '),
    order.shipping_address_line_1,
    order.shipping_address_line_2,
    [order.shipping_city, order.shipping_state, order.shipping_zip].filter(Boolean).join(', '),
    order.shipping_country,
  ]);

  if (email) {
    const existing = await dbGet(
      db,
      `SELECT * FROM customers WHERE company_id = ? AND LOWER(email) = ? LIMIT 1`,
      [companyId, email]
    );
    if (existing) {
      // Refresh contact info if blank
      await dbRun(
        db,
        `UPDATE customers SET
           name = COALESCE(NULLIF(name,''), ?),
           phone = COALESCE(NULLIF(phone,''), ?),
           billing_address = CASE WHEN billing_address IS NULL OR billing_address = '' THEN ? ELSE billing_address END,
           shipping_address = CASE WHEN shipping_address IS NULL OR shipping_address = '' THEN ? ELSE shipping_address END
         WHERE id = ?`,
        [name, phone, billing, shipping, existing.id]
      );
      return existing.id;
    }
  }

  // Fallback: same name + company without email match
  if (!email) {
    const byName = await dbGet(
      db,
      `SELECT * FROM customers WHERE company_id = ? AND name = ? LIMIT 1`,
      [companyId, name]
    );
    if (byName) return byName.id;
  }

  const r = await dbRun(
    db,
    `INSERT INTO customers (name, email, phone, billing_address, shipping_address, company_id)
     VALUES (?,?,?,?,?,?)`,
    [name, email || null, phone || null, billing, shipping, companyId]
  );
  return r.lastID;
}

function lineSku(line) {
  return String(line.model_number || line.product_model || `EC-P${line.product_id || line.orderdetail_id}`).trim();
}

function lineTitle(line) {
  return String(line.title || line.product_title || lineSku(line)).trim();
}

function lineDescription(line) {
  return stripHtml(line.product_description || '');
}

function lineRetail(line) {
  const catalog = Number(line.catalog_price || 0);
  const unit = Number(line.unit_price || 0);
  return catalog > 0 ? catalog : unit;
}

/** Find existing product for this company by SKU (no auto-create). */
async function findProduct(db, companyId, sku) {
  if (!db) return null;
  // Prefer same company
  let product = await dbGet(
    db,
    'SELECT * FROM products WHERE sku = ? AND company_id = ? LIMIT 1',
    [sku, companyId]
  );
  if (product) return product;
  // Global unique SKU — if it exists for this company via any row with matching company
  product = await dbGet(db, 'SELECT * FROM products WHERE sku = ? LIMIT 1', [sku]);
  if (product && Number(product.company_id) === Number(companyId)) return product;
  return null;
}

function missingProductPayload(line) {
  const sku = lineSku(line);
  return {
    sku,
    name: lineTitle(line),
    description: lineDescription(line),
    retail_price: lineRetail(line),
    unit_price: Number(line.unit_price || 0),
    catalog_price: Number(line.catalog_price || 0),
    product_cost_hint: Number(line.product_cost || 0) || null,
    orderdetail_id: line.orderdetail_id,
    orderdetail_ids: [line.orderdetail_id],
    easycart_product_id: line.product_id || null,
  };
}

/**
 * Create a product from EasyCart import prompt.
 * wholesale_price is required (> 0 or explicitly 0 is ok if provided as number including 0? User said must be filled - allow 0).
 */
async function createProductFromEasycart(db, body) {
  const companyId = Number(body.company_id || 1);
  const sku = String(body.sku || '').trim();
  const name = String(body.name || '').trim();
  const description = stripHtml(body.description || '');
  const retail_price = Number(body.retail_price);
  const wholesaleRaw = body.wholesale_price;
  if (!sku) throw new Error('SKU is required');
  if (!name) throw new Error('Product name / description title is required');
  if (wholesaleRaw === undefined || wholesaleRaw === null || wholesaleRaw === '') {
    throw new Error('Wholesale price is required to add this product');
  }
  const wholesale_price = Number(wholesaleRaw);
  if (Number.isNaN(wholesale_price)) throw new Error('Wholesale price must be a number');
  if (Number.isNaN(retail_price)) throw new Error('Retail price must be a number');

  const existing = await dbGet(db, 'SELECT * FROM products WHERE sku = ? LIMIT 1', [sku]);
  if (existing) {
    if (Number(existing.company_id) === companyId) {
      return { product: existing, created: false };
    }
    throw new Error(
      `SKU "${sku}" already exists for another company (id ${existing.company_id}). Use a different SKU.`
    );
  }

  // description column may not exist yet on very old DBs mid-migration
  let r;
  try {
    r = await dbRun(
      db,
      `INSERT INTO products (sku, name, wholesale_price, retail_price, stock, vendor_id, company_id, description)
       VALUES (?,?,?,?,?,?,?,?)`,
      [sku, name, wholesale_price, retail_price || 0, Number(body.stock || 0), body.vendor_id || null, companyId, description || null]
    );
  } catch (e) {
    if (String(e.message || '').includes('no such column: description')) {
      r = await dbRun(
        db,
        `INSERT INTO products (sku, name, wholesale_price, retail_price, stock, vendor_id, company_id)
         VALUES (?,?,?,?,?,?,?)`,
        [sku, name, wholesale_price, retail_price || 0, Number(body.stock || 0), body.vendor_id || null, companyId]
      );
    } else {
      throw e;
    }
  }
  const product = await dbGet(db, 'SELECT * FROM products WHERE id = ?', [r.lastID]);
  return { product, created: true };
}

/**
 * Import an EasyCart order (full or selected line items).
 * body: {
 *   company_id, order_id, orderdetail_ids?,
 *   include_shipping?, include_tax?, include_discount?,
 *   new_products?: [{ sku, name, wholesale_price, retail_price, description }]  // optional pre-add
 * }
 * If SKUs missing and not provided in new_products → returns need_products (does not import).
 */
async function importOrder(db, body) {
  const companyId = Number(body.company_id || 1);
  const orderId = Number(body.order_id);
  if (!orderId) throw new Error('order_id required');

  const detail = await fetchOrderDetail(orderId);
  if (!detail) throw new Error(`EasyCart order ${orderId} not found`);
  const { order, lines } = detail;
  if (!lines.length) throw new Error('Order has no line items');

  let selected = lines;
  if (Array.isArray(body.orderdetail_ids) && body.orderdetail_ids.length) {
    const want = new Set(body.orderdetail_ids.map(Number));
    selected = lines.filter((l) => want.has(Number(l.orderdetail_id)));
    if (!selected.length) throw new Error('No matching line items selected');
  }

  // Block re-import of the same line for this company
  const already = await dbAll(
    db,
    `SELECT orderdetail_id FROM easycart_import_lines
     WHERE company_id = ? AND orderdetail_id IN (${selected.map(() => '?').join(',')})`,
    [companyId, ...selected.map((l) => l.orderdetail_id)]
  );
  if (already.length) {
    const ids = already.map((r) => r.orderdetail_id).join(', ');
    throw new Error(`Line(s) already imported for this company: ${ids}. Uncheck those lines or pick others.`);
  }

  // Optionally create products the user just confirmed
  if (Array.isArray(body.new_products) && body.new_products.length) {
    for (const np of body.new_products) {
      await createProductFromEasycart(db, { ...np, company_id: companyId });
    }
  }

  // Resolve products — collect missing SKUs (unique by sku)
  const missingBySku = {};
  const resolved = [];
  for (const line of selected) {
    const sku = lineSku(line);
    const product = await findProduct(db, companyId, sku);
    if (!product) {
      if (!missingBySku[sku]) {
        missingBySku[sku] = missingProductPayload(line);
      } else {
        const ids = missingBySku[sku].orderdetail_ids || [];
        if (!ids.includes(line.orderdetail_id)) ids.push(line.orderdetail_id);
        missingBySku[sku].orderdetail_ids = ids;
      }
    } else {
      resolved.push({ line, product });
    }
  }

  const missing = Object.values(missingBySku);
  if (missing.length) {
    const err = new Error(
      `${missing.length} SKU(s) not in the system. Add them with wholesale price to continue.`
    );
    err.code = 'NEED_PRODUCTS';
    err.need_products = true;
    err.missing_products = missing;
    throw err;
  }

  const isFull = selected.length === lines.length;
  const lineSubtotal = selected.reduce((s, l) => s + Number(l.total_price || 0), 0);
  const orderSub = Number(order.sub_total || 0);
  const ratio = orderSub > 0.001 ? lineSubtotal / orderSub : isFull ? 1 : 0;

  const includeShipping = body.include_shipping !== false && isFull
    ? true
    : body.include_shipping === true;
  const includeTax = body.include_tax !== false && isFull
    ? true
    : body.include_tax === true;
  const includeDiscount = body.include_discount !== false && isFull
    ? true
    : body.include_discount === true;

  // For partial: default shipping/tax/discount off unless user opts in (then proportional)
  let shipping = 0;
  let tax = 0;
  let discount = 0;
  if (isFull) {
    shipping = includeShipping ? Number(order.shipping_total || 0) : 0;
    tax = includeTax ? Number(order.tax_total || 0) : 0;
    discount = includeDiscount ? Number(order.discount_total || 0) : 0;
  } else {
    shipping = includeShipping ? Math.round(Number(order.shipping_total || 0) * ratio * 100) / 100 : 0;
    tax = includeTax ? Math.round(Number(order.tax_total || 0) * ratio * 100) / 100 : 0;
    discount = includeDiscount ? Math.round(Number(order.discount_total || 0) * ratio * 100) / 100 : 0;
  }

  const subtotal = Math.round(lineSubtotal * 100) / 100;
  const total = Math.round((subtotal + tax + shipping - discount) * 100) / 100;
  // Rate is the order's own tax divided by taxable merchandise (subtotal minus discount).
  // When that base is missing, use the company's default rate.
  const taxable = Math.max(0, Math.round((subtotal - discount) * 100) / 100);
  let tax_rate = rateFromTaxAmount(tax, taxable > 0 ? taxable : subtotal);
  let tax_label = null;
  const companyRow = await dbGet(db, 'SELECT settings_json FROM companies WHERE id = ?', [companyId]);
  let companySettings = {};
  try {
    companySettings = JSON.parse((companyRow && companyRow.settings_json) || '{}');
  } catch (e) {
    companySettings = {};
  }
  const configured = Array.isArray(companySettings.tax_rates) ? companySettings.tax_rates : [];
  if (tax_rate == null) {
    tax_rate = normalizeTaxRate(companySettings.default_tax_rate || 0);
  }
  const matched = configured.find((r) => Math.abs(normalizeTaxRate(r.rate) - tax_rate) < 0.0001);
  if (matched && matched.label) tax_label = String(matched.label);
  const date = orderDateOnly(order.order_date);
  const payment_method = mapPaymentMethod(order.payment_method);
  const mode = isFull ? 'full' : 'partial';

  const priorPartials = await dbGet(
    db,
    `SELECT COUNT(*) AS n FROM easycart_imports WHERE company_id=? AND order_id=?`,
    [companyId, orderId]
  );
  const seq = Number(priorPartials?.n || 0) + 1;
  const txn = mode === 'full' ? `EC-${orderId}` : `EC-${orderId}-P${seq}`;

  // Ensure unique transaction_number
  const clash = await dbGet(db, 'SELECT id FROM sales WHERE transaction_number = ?', [txn]);
  const transaction_number = clash ? `${txn}-${Date.now().toString().slice(-4)}` : txn;

  const customerId = await findOrCreateCustomer(db, companyId, order);

  const saleItems = [];
  for (const { line, product } of resolved) {
    saleItems.push({
      product_id: product.id,
      quantity: Number(line.quantity || 1),
      custom_price: Number(line.unit_price || 0),
      wholesale_price: Number(product.wholesale_price || 0),
      orderdetail_id: line.orderdetail_id,
      sku: product.sku,
      title: line.title || product.name,
    });
  }

  const cfg = remitConfig();
  // Imported EasyCart sales = Party A products (clean split from cleanStartDate)
  const productOwner =
    body.product_owner === 'party_b' || body.product_owner === 'party_a'
      ? body.product_owner
      : cfg.importOwner;

  const notes = [
    `Imported from WP EasyCart order #${orderId}`,
    mode === 'partial' ? `(partial: ${selected.length}/${lines.length} lines)` : '(full order)',
    productOwner === 'party_a' ? 'Owner: Party A (product remittance)' : 'Owner: Party B (product remittance)',
    order.order_status ? `Status: ${order.order_status}` : null,
    order.tracking_number ? `Tracking: ${order.tracking_number}` : null,
    order.paypal_transaction_id ? `PayPal: ${order.paypal_transaction_id}` : null,
    order.gateway_transaction_id ? `Gateway: ${order.gateway_transaction_id}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  // Prefer EasyCart shipping block on the sale (one-time ship-to); falls back empty
  const saleShipAddr = [
    order._shipping_address_block,
    [
      order.shipping_company_name,
      [order.shipping_first_name, order.shipping_last_name].filter(Boolean).join(' '),
      order.shipping_address_line_1,
      order.shipping_address_line_2,
      [order.shipping_city, order.shipping_state, order.shipping_zip].filter(Boolean).join(', '),
      order.shipping_country,
    ]
      .filter(Boolean)
      .join('\n'),
  ]
    .map((s) => (s != null ? String(s).trim() : ''))
    .find((s) => s.length > 0) || null;

  // Insert sale (stock is not adjusted on this import path)
  const saleResult = await dbRun(
    db,
    `INSERT INTO sales (
      customer_id, date, subtotal, tax, tax_rate, tax_label, shipping, discount, total,
      payment_method, transaction_number, notes, company_id, customer_name, source, product_owner, shipping_address
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, (SELECT name FROM customers WHERE id = ?), ?, ?, ?)`,
    [
      customerId,
      date,
      subtotal,
      tax,
      tax_rate,
      tax_label,
      shipping,
      discount,
      total,
      payment_method,
      transaction_number,
      notes,
      companyId,
      customerId,
      'wpeasycart',
      productOwner,
      saleShipAddr,
    ]
  );
  const saleId = saleResult.lastID;

  for (const item of saleItems) {
    await dbRun(
      db,
      `INSERT INTO sale_items (transaction_id, product_id, quantity, custom_price, wholesale_price, company_id)
       VALUES (?,?,?,?,?,?)`,
      [saleId, item.product_id, item.quantity, item.custom_price, item.wholesale_price, companyId]
    );
  }

  // Accrue Due to Party A/Party B: product base after card fee (tax stays with the company)
  const base = productBase(subtotal, shipping, discount);
  const remitAmt = remittanceAfterFee(base, cfg.feeRate);
  let settlementId = null;
  if (remitAmt > 0.0001) {
    try {
      const setR = await dbRun(
        db,
        `INSERT INTO books_settlements (
          company_id, settlement_date, period_start, period_end, party, entry_type,
          gross_sales, fees, refunds, tax_held, amount,
          payment_method, reference_number, notes
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          companyId,
          date,
          date,
          date,
          productOwner,
          'accrue',
          base,
          Math.round(base * cfg.feeRate * 100) / 100,
          0,
          tax,
          remitAmt,
          null,
          transaction_number,
          `Auto EC-import sale_id=${saleId} order=${orderId} owner=${productOwner} fee=${(cfg.feeRate * 100).toFixed(1)}%`,
        ]
      );
      settlementId = setR.lastID;
    } catch (e) {
      console.warn('[easycart] settlement accrue skipped:', e.message);
    }
  }

  const imp = await dbRun(
    db,
    `INSERT INTO easycart_imports (
      company_id, order_id, sale_id, import_mode, subtotal, tax, shipping, discount, total, notes,
      product_owner, settlement_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      companyId,
      orderId,
      saleId,
      mode,
      subtotal,
      tax,
      shipping,
      discount,
      total,
      notes,
      productOwner,
      settlementId,
    ]
  );
  const importId = imp.lastID;

  for (const item of saleItems) {
    await dbRun(
      db,
      `INSERT INTO easycart_import_lines (import_id, company_id, order_id, orderdetail_id, sale_id)
       VALUES (?,?,?,?,?)`,
      [importId, companyId, orderId, item.orderdetail_id, saleId]
    );
  }

  const sale = await dbGet(
    db,
    `SELECT s.*, c.name AS customer_name, c.email AS customer_email
     FROM sales s LEFT JOIN customers c ON c.id = s.customer_id WHERE s.id = ?`,
    [saleId]
  );
  sale.items = await dbAll(db, 'SELECT * FROM sale_items WHERE transaction_id = ?', [saleId]);

  return {
    sale,
    import_id: importId,
    mode,
    order_id: orderId,
    lines_imported: selected.length,
    lines_total: lines.length,
    transaction_number,
    product_owner: productOwner,
    remittance: {
      base,
      fee_rate: cfg.feeRate,
      amount_due: remitAmt,
      settlement_id: settlementId,
      party: productOwner,
    },
  };
}

/**
 * Undo one EasyCart import (by import_id or sale_id), or all imports for an order_id.
 * Removes sale + sale_items + import tracking. Does not delete products.
 * Deletes customer only if they have no other sales/invoices and source was EC-only empty trail.
 */
async function undoImport(db, body) {
  const companyId = Number(body.company_id || 1);
  let imports = [];

  if (body.import_id) {
    const row = await dbGet(
      db,
      'SELECT * FROM easycart_imports WHERE id = ? AND company_id = ?',
      [Number(body.import_id), companyId]
    );
    if (!row) throw new Error('Import not found');
    imports = [row];
  } else if (body.sale_id) {
    const rows = await dbAll(
      db,
      'SELECT * FROM easycart_imports WHERE sale_id = ? AND company_id = ?',
      [Number(body.sale_id), companyId]
    );
    if (!rows.length) throw new Error('No EasyCart import found for that sale');
    imports = rows;
  } else if (body.order_id) {
    imports = await dbAll(
      db,
      'SELECT * FROM easycart_imports WHERE order_id = ? AND company_id = ? ORDER BY id DESC',
      [Number(body.order_id), companyId]
    );
    if (!imports.length) throw new Error('No imports found for that EasyCart order');
  } else {
    throw new Error('import_id, sale_id, or order_id required');
  }

  const undone = [];
  for (const imp of imports) {
    const saleId = imp.sale_id;
    let sale = null;
    if (saleId) {
      sale = await dbGet(db, 'SELECT * FROM sales WHERE id = ? AND company_id = ?', [saleId, companyId]);
    }
    const customerId = sale?.customer_id || null;

    // Reverse auto remittance accrual (Due to Party A/Party B)
    try {
      if (imp.settlement_id) {
        await dbRun(db, 'DELETE FROM books_settlements WHERE id = ? AND company_id = ?', [
          imp.settlement_id,
          companyId,
        ]);
      } else if (saleId) {
        await dbRun(
          db,
          `DELETE FROM books_settlements WHERE company_id = ? AND notes LIKE ?`,
          [companyId, `%sale_id=${saleId}%`]
        );
      }
    } catch (_) {
      /* settlements table may not exist on older DBs */
    }

    // Remove tracking first (so partial failure is less messy), then sale
    await dbRun(db, 'DELETE FROM easycart_import_lines WHERE import_id = ? AND company_id = ?', [
      imp.id,
      companyId,
    ]);
    // Also clear any orphan lines pointing at this sale
    if (saleId) {
      await dbRun(db, 'DELETE FROM easycart_import_lines WHERE sale_id = ? AND company_id = ?', [
        saleId,
        companyId,
      ]);
    }
    await dbRun(db, 'DELETE FROM easycart_imports WHERE id = ? AND company_id = ?', [imp.id, companyId]);

    if (saleId) {
      await dbRun(db, 'DELETE FROM sale_items WHERE transaction_id = ? AND company_id = ?', [
        saleId,
        companyId,
      ]);
      await dbRun(db, 'DELETE FROM sales WHERE id = ? AND company_id = ?', [saleId, companyId]);
    }

    // Optional: remove customer if they have no remaining sales / invoices / estimates / deposits
    let customer_deleted = false;
    if (customerId) {
      const otherSales = await dbGet(
        db,
        'SELECT COUNT(*) AS n FROM sales WHERE customer_id = ? AND company_id = ?',
        [customerId, companyId]
      );
      let otherRefs = Number(otherSales?.n || 0);
      try {
        const inv = await dbGet(
          db,
          'SELECT COUNT(*) AS n FROM invoices WHERE customer_id = ? AND company_id = ?',
          [customerId, companyId]
        );
        otherRefs += Number(inv?.n || 0);
      } catch (_) {}
      try {
        const est = await dbGet(
          db,
          'SELECT COUNT(*) AS n FROM estimates WHERE customer_id = ? AND company_id = ?',
          [customerId, companyId]
        );
        otherRefs += Number(est?.n || 0);
      } catch (_) {}
      try {
        const dep = await dbGet(
          db,
          'SELECT COUNT(*) AS n FROM deposits WHERE customer_id = ? AND company_id = ?',
          [customerId, companyId]
        );
        otherRefs += Number(dep?.n || 0);
      } catch (_) {}

      if (otherRefs === 0) {
        await dbRun(db, 'DELETE FROM customers WHERE id = ? AND company_id = ?', [
          customerId,
          companyId,
        ]);
        customer_deleted = true;
      }
    }

    undone.push({
      import_id: imp.id,
      sale_id: saleId,
      order_id: imp.order_id,
      transaction_number: sale?.transaction_number || null,
      total: sale?.total != null ? sale.total : imp.total,
      customer_deleted,
    });
  }

  return {
    ok: true,
    undone_count: undone.length,
    undone,
  };
}

async function listImportsForOrder(db, companyId, orderId) {
  if (!db) return [];
  const rows = await dbAll(
    db,
    `SELECT i.*, s.transaction_number, s.customer_name, s.date AS sale_date
     FROM easycart_imports i
     LEFT JOIN sales s ON s.id = i.sale_id
     WHERE i.company_id = ? AND i.order_id = ?
     ORDER BY i.id DESC`,
    [companyId, orderId]
  );
  const withLines = [];
  for (const r of rows) {
    const lines = await dbAll(
      db,
      'SELECT orderdetail_id FROM easycart_import_lines WHERE import_id = ?',
      [r.id]
    );
    withLines.push({
      ...r,
      orderdetail_ids: lines.map((l) => l.orderdetail_id),
      line_count: lines.length,
    });
  }
  return withLines;
}

function registerEasycartRoutes(app, db, options = {}) {
  const readOnly = !!options.readOnly || !db;

  app.get('/api/easycart/ping', async (req, res) => {
    try {
      if (ecConfig.mode === 'remote') {
        const data = await remoteFeedGet('/api/easycart/ping');
        return res.json({ ...data, mode: 'remote', remoteUrl: ecConfig.remoteUrl });
      }
      const pool = getPool();
      const [rows] = await pool.query('SELECT COUNT(*) AS cnt, MAX(order_id) AS max_id FROM ec_order');
      res.json({
        ok: true,
        mode: 'local',
        database: ecConfig.database,
        order_count: Number(rows[0]?.cnt || 0),
        max_order_id: rows[0]?.max_id,
        read_only_feed: readOnly,
      });
    } catch (e) {
      console.error('[easycart] ping', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/easycart/statuses', async (req, res) => {
    try {
      res.json(await listStatuses());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/easycart/orders', async (req, res) => {
    try {
      const company_id = Number(req.query.company_id || 1);
      const page = Number(req.query.page || 1);
      const limit = Math.min(100, Number(req.query.limit || 50));
      const q = req.query.q || '';
      const from = req.query.from || null;
      const to = req.query.to || null;
      const status_id = req.query.status_id || 'all';
      const importedFilter = req.query.imported || 'all'; // all | yes | no | partial

      const result = await fetchOrders({ q, page, limit, from, to, status_id });
      const orderIds = result.orders.map((o) => o.order_id);
      const statusMap = await getImportStatusMap(db, company_id, orderIds);

      let orders = result.orders.map((o) => {
        const st = statusMap[o.order_id] || { imported_line_ids: [], import_count: 0, sale_ids: [] };
        const lineCount = Number(o.line_count || 0);
        const importedLines = st.imported_line_ids.length;
        let import_status = 'none';
        if (importedLines > 0 && importedLines >= lineCount && lineCount > 0) import_status = 'full';
        else if (importedLines > 0) import_status = 'partial';
        return {
          order_id: o.order_id,
          order_date: o.order_date,
          date: orderDateOnly(o.order_date),
          order_status: o.order_status,
          orderstatus_id: o.orderstatus_id,
          sub_total: Number(o.sub_total || 0),
          tax_total: Number(o.tax_total || 0),
          shipping_total: Number(o.shipping_total || 0),
          discount_total: Number(o.discount_total || 0),
          grand_total: Number(o.grand_total || 0),
          payment_method: o.payment_method,
          payment_method_mapped: mapPaymentMethod(o.payment_method),
          user_email: o.user_email,
          customer_name: [o.billing_first_name, o.billing_last_name].filter(Boolean).join(' ').trim(),
          shipping_name: [o.shipping_first_name, o.shipping_last_name].filter(Boolean).join(' ').trim(),
          phone: o.billing_phone || o.shipping_phone,
          line_count: lineCount,
          import_status,
          imported_line_count: importedLines,
          sale_ids: st.sale_ids,
        };
      });

      if (importedFilter === 'yes') orders = orders.filter((o) => o.import_status === 'full');
      else if (importedFilter === 'no') orders = orders.filter((o) => o.import_status === 'none');
      else if (importedFilter === 'partial') orders = orders.filter((o) => o.import_status === 'partial');

      res.json({
        company_id,
        total: importedFilter === 'all' ? result.total : orders.length,
        page: result.page,
        limit: result.limit,
        orders,
      });
    } catch (e) {
      console.error('[easycart] list', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/easycart/orders/:id', async (req, res) => {
    try {
      const company_id = Number(req.query.company_id || 1);
      const orderId = Number(req.params.id);
      const detail = await fetchOrderDetail(orderId);
      if (!detail) return res.status(404).json({ error: 'Order not found' });
      const { order, lines } = detail;
      const statusMap = await getImportStatusMap(db, company_id, [orderId]);
      const st = statusMap[orderId] || { imported_line_ids: [], sale_ids: [] };
      const importedSet = new Set(st.imported_line_ids);

      res.json({
        company_id,
        order: {
          order_id: order.order_id,
          order_date: order.order_date,
          date: orderDateOnly(order.order_date),
          order_status: order.order_status,
          orderstatus_id: order.orderstatus_id,
          sub_total: Number(order.sub_total || 0),
          tax_total: Number(order.tax_total || 0),
          shipping_total: Number(order.shipping_total || 0),
          discount_total: Number(order.discount_total || 0),
          grand_total: Number(order.grand_total || 0),
          payment_method: order.payment_method,
          payment_method_mapped: mapPaymentMethod(order.payment_method),
          user_email: order.user_email,
          billing: {
            name: [order.billing_first_name, order.billing_last_name].filter(Boolean).join(' '),
            company: order.billing_company_name,
            phone: order.billing_phone,
            address: formatAddress([
              order.billing_address_line_1,
              order.billing_address_line_2,
              [order.billing_city, order.billing_state, order.billing_zip].filter(Boolean).join(', '),
              order.billing_country,
            ]),
          },
          shipping: {
            name: [order.shipping_first_name, order.shipping_last_name].filter(Boolean).join(' '),
            company: order.shipping_company_name,
            phone: order.shipping_phone,
            address: formatAddress([
              order.shipping_address_line_1,
              order.shipping_address_line_2,
              [order.shipping_city, order.shipping_state, order.shipping_zip].filter(Boolean).join(', '),
              order.shipping_country,
            ]),
          },
          tracking_number: order.tracking_number,
          order_notes: order.order_notes,
          customer_notes: order.order_customer_notes,
        },
        lines: await Promise.all(
          lines.map(async (l) => {
            const sku = lineSku(l);
            const inSystem = !!(await findProduct(db, company_id, sku));
            return {
              orderdetail_id: l.orderdetail_id,
              product_id: l.product_id,
              model_number: l.model_number,
              title: l.title,
              description: lineDescription(l),
              quantity: l.quantity,
              unit_price: Number(l.unit_price || 0),
              total_price: Number(l.total_price || 0),
              catalog_price: Number(l.catalog_price || 0),
              product_cost_hint: Number(l.product_cost || 0) || null,
              in_system: inSystem,
              options: [l.optionitem_name_1, l.optionitem_name_2, l.optionitem_name_3, l.optionitem_name_4, l.optionitem_name_5]
                .filter((x) => x && String(x).trim())
                .join(', '),
              already_imported: importedSet.has(l.orderdetail_id),
            };
          })
        ),
        imported_line_ids: st.imported_line_ids,
        sale_ids: st.sale_ids,
        imports: await listImportsForOrder(db, company_id, orderId),
      });
    } catch (e) {
      console.error('[easycart] detail', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Write routes only when we have a local accounting DB (not the public feed)
  if (!readOnly) {
    app.post('/api/easycart/import', async (req, res) => {
      try {
        const result = await importOrder(db, req.body || {});
        res.status(201).json(result);
      } catch (e) {
        if (e.code === 'NEED_PRODUCTS' || e.need_products) {
          return res.status(409).json({
            error: e.message,
            need_products: true,
            missing_products: e.missing_products || [],
          });
        }
        console.error('[easycart] import', e.message);
        res.status(400).json({ error: e.message });
      }
    });

    /** Add a product when EasyCart SKU is not in accounting (wholesale required) */
    app.post('/api/easycart/products', async (req, res) => {
      try {
        const result = await createProductFromEasycart(db, req.body || {});
        res.status(result.created ? 201 : 200).json(result);
      } catch (e) {
        console.error('[easycart] add product', e.message);
        res.status(400).json({ error: e.message });
      }
    });

    /** Undo one import (import_id or sale_id) or all imports for an order_id */
    app.post('/api/easycart/undo', async (req, res) => {
      try {
        const result = await undoImport(db, req.body || {});
        res.json(result);
      } catch (e) {
        console.error('[easycart] undo', e.message);
        res.status(400).json({ error: e.message });
      }
    });

    app.delete('/api/easycart/import/:id', async (req, res) => {
      try {
        const result = await undoImport(db, {
          company_id: Number(req.query.company_id || req.body?.company_id || 1),
          import_id: Number(req.params.id),
        });
        res.json(result);
      } catch (e) {
        console.error('[easycart] undo delete', e.message);
        res.status(400).json({ error: e.message });
      }
    });

    app.get('/api/easycart/imports', async (req, res) => {
      try {
        const company_id = Number(req.query.company_id || 1);
        const order_id = req.query.order_id ? Number(req.query.order_id) : null;
        if (order_id) {
          return res.json({
            company_id,
            order_id,
            imports: await listImportsForOrder(db, company_id, order_id),
          });
        }
        // Recent imports for company
        const rows = await dbAll(
          db,
          `SELECT i.*, s.transaction_number, s.customer_name
           FROM easycart_imports i
           LEFT JOIN sales s ON s.id = i.sale_id
           WHERE i.company_id = ?
           ORDER BY i.id DESC
           LIMIT 100`,
          [company_id]
        );
        res.json({ company_id, imports: rows });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    /**
     * Party B remittance preview for a period:
     * EasyCart store totals (all orders) − Party A imports = Party B product base;
     * Party B owed = Party B base × (1 − feeRate). Tax excluded from remittance base.
     */
    app.get('/api/easycart/mark-remittance-preview', async (req, res) => {
      try {
        const company_id = Number(req.query.company_id || 1);
        const cfg = remitConfig();
        const from = (req.query.from || cfg.cleanStartDate).slice(0, 10);
        const to = (req.query.to || DateTime.now().toFormat('yyyy-MM-dd')).slice(0, 10);
        const feeRate = req.query.fee_rate != null ? Number(req.query.fee_rate) : cfg.feeRate;

        // All EasyCart orders in range (product base = sub+ship−disc)
        const { orders } = await fetchOrders({
          from,
          to,
          page: 1,
          limit: 5000,
          status_id: 'all',
        });
        let storeBase = 0;
        let storeTax = 0;
        let storeGrand = 0;
        let storeCount = 0;
        for (const o of orders) {
          storeCount += 1;
          storeBase += productBase(o.sub_total, o.shipping_total, o.discount_total);
          storeTax += Number(o.tax_total || 0);
          storeGrand += Number(o.grand_total || 0);
        }
        storeBase = Math.round(storeBase * 100) / 100;
        storeTax = Math.round(storeTax * 100) / 100;
        storeGrand = Math.round(storeGrand * 100) / 100;

        // Party A imports in range (from accounting DB) — product_owner='party_a' only
        const party_aRowsStrict = await dbAll(
          db,
          `SELECT COALESCE(SUM(subtotal + shipping - discount),0) AS base,
                  COALESCE(SUM(tax),0) AS tax,
                  COALESCE(SUM(total),0) AS grand,
                  COUNT(*) AS n
           FROM sales
           WHERE company_id=? AND source='wpeasycart'
             AND date(date)>=date(?) AND date(date)<=date(?)
             AND product_owner='party_a'`,
          [company_id, from, to]
        );
        const party_aBase = Math.round(Number(party_aRowsStrict[0]?.base || 0) * 100) / 100;
        const party_aTax = Math.round(Number(party_aRowsStrict[0]?.tax || 0) * 100) / 100;
        const party_aCount = Number(party_aRowsStrict[0]?.n || 0);

        const markBase = Math.max(0, Math.round((storeBase - party_aBase) * 100) / 100);
        const markFee = Math.round(markBase * feeRate * 100) / 100;
        const markDue = remittanceAfterFee(markBase, feeRate);
        const party_aFee = Math.round(party_aBase * feeRate * 100) / 100;
        const party_aDue = remittanceAfterFee(party_aBase, feeRate);

        res.json({
          company_id,
          from,
          to,
          fee_rate: feeRate,
          clean_start_date: cfg.cleanStartDate,
          policy:
            'Imported EasyCart sales = Party A (Due to Party A). Unimported store volume = Party B (Due to Party B). Remit after fee on product base (subtotal+shipping−discount). Tax stays with the company.',
          store: {
            order_count: storeCount,
            product_base: storeBase,
            tax: storeTax,
            grand_total: storeGrand,
          },
          party_a_imported: {
            sale_count: party_aCount,
            product_base: party_aBase,
            tax: party_aTax,
            fee: party_aFee,
            amount_due: party_aDue,
          },
          mark: {
            product_base: markBase,
            fee: markFee,
            amount_due: markDue,
          },
        });
      } catch (e) {
        console.error('[easycart] mark-remittance-preview', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    /** Accrue Party B remittance for a period (from preview math). */
    app.post('/api/easycart/mark-remittance-accrue', async (req, res) => {
      try {
        const b = req.body || {};
        const company_id = Number(b.company_id || 1);
        const cfg = remitConfig();
        const from = (b.from || cfg.cleanStartDate).slice(0, 10);
        const to = (b.to || DateTime.now().toFormat('yyyy-MM-dd')).slice(0, 10);
        const feeRate = b.fee_rate != null ? Number(b.fee_rate) : cfg.feeRate;

        // Recompute to avoid trusting client math alone
        const previewRes = await new Promise((resolve, reject) => {
          // inline compute (same as GET)
          (async () => {
            const { orders } = await fetchOrders({ from, to, page: 1, limit: 5000, status_id: 'all' });
            let storeBase = 0;
            for (const o of orders) {
              storeBase += productBase(o.sub_total, o.shipping_total, o.discount_total);
            }
            storeBase = Math.round(storeBase * 100) / 100;
            const party_aRowsStrict = await dbAll(
              db,
              `SELECT COALESCE(SUM(subtotal + shipping - discount),0) AS base, COUNT(*) AS n
               FROM sales
               WHERE company_id=? AND source='wpeasycart'
                 AND date(date)>=date(?) AND date(date)<=date(?)
                 AND product_owner='party_a'`,
              [company_id, from, to]
            );
            const party_aBase = Math.round(Number(party_aRowsStrict[0]?.base || 0) * 100) / 100;
            const markBase = Math.max(0, Math.round((storeBase - party_aBase) * 100) / 100);
            const markDue = remittanceAfterFee(markBase, feeRate);
            const markFee = Math.round(markBase * feeRate * 100) / 100;
            resolve({ storeBase, party_aBase, markBase, markDue, markFee, orderCount: orders.length, party_aCount: Number(party_aRowsStrict[0]?.n || 0) });
          })().catch(reject);
        });

        if (!(previewRes.markDue > 0)) {
          return res.status(400).json({
            error: 'Party B amount due is zero for this period (nothing left after Party A imports)',
            preview: previewRes,
          });
        }

        // Avoid double-accrue: same period note marker
        const marker = `Auto Party B remittance ${from}→${to}`;
        const existing = await dbGet(
          db,
          `SELECT id FROM books_settlements WHERE company_id=? AND party='party_b' AND entry_type='accrue' AND notes LIKE ?`,
          [company_id, `${marker}%`]
        );
        if (existing && !b.force) {
          return res.status(409).json({
            error: 'Party B remittance already accrued for this period. Pass force:true to add another.',
            settlement_id: existing.id,
          });
        }

        const settlement_date = b.settlement_date || to;
        const r = await dbRun(
          db,
          `INSERT INTO books_settlements (
            company_id, settlement_date, period_start, period_end, party, entry_type,
            gross_sales, fees, refunds, tax_held, amount,
            payment_method, reference_number, notes
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            company_id,
            settlement_date,
            from,
            to,
            'party_b',
            'accrue',
            previewRes.markBase,
            previewRes.markFee,
            0,
            0,
            previewRes.markDue,
            null,
            null,
            `${marker} | storeBase=${previewRes.storeBase} party_aBase=${previewRes.party_aBase} fee=${(feeRate * 100).toFixed(1)}%`,
          ]
        );
        const row = await dbGet(db, 'SELECT * FROM books_settlements WHERE id=?', [r.lastID]);
        res.status(201).json({
          settlement: row,
          preview: previewRes,
          fee_rate: feeRate,
          message: `Accrued Due to Party B $${previewRes.markDue.toFixed(2)} for ${from} → ${to}`,
        });
      } catch (e) {
        console.error('[easycart] mark-remittance-accrue', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    app.get('/api/easycart/remittance-policy', (req, res) => {
      const cfg = remitConfig();
      res.json({
        clean_start_date: cfg.cleanStartDate,
        fee_rate: cfg.feeRate,
        import_owner: cfg.importOwner,
        policy:
          'From clean_start_date: import = Party A (auto Due to Party A after fee). Unimported EasyCart volume = Party B. Monthly: preview Party B remittance → accrue → pay via Books (Party B / Party A tab) minus fee already applied.',
      });
    });
  }
}

module.exports = {
  initEasycartSchema,
  registerEasycartRoutes,
  getPool,
  undoImport,
  fetchOrders,
  fetchOrderDetail,
  listStatuses,
  remitConfig,
  productBase,
  remittanceAfterFee,
};
