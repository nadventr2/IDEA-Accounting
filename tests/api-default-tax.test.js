/**
 * API default sales tax. Starts its own server on a free port and a temp database.
 * Does not use the live app on port 3003.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const repo = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-default-tax-'));
const dbPath = path.join(tmp, 'accounting.db');
const configPath = path.join(tmp, 'config.json');

let child = null;
let base = '';
let customerId = 0;
let productId = 0;
let serverLog = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function closeTo(actual, expected, label) {
  const n = Number(actual);
  assert.ok(Number.isFinite(n), label + ' is not a number: ' + actual);
  assert.ok(Math.abs(n - expected) < 0.001, label + ' ' + n + ' != ' + expected);
}

async function stopServer() {
  if (!child || child.exitCode != null) return;
  const pid = child.pid;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    sleep(3000).then(() => false),
  ]);
  if (!exited) {
    try { process.kill(pid, 'SIGKILL'); } catch (e) { /* already gone */ }
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      sleep(2000),
    ]);
  }
}

test.before(async () => {
  const port = await freePort();
  fs.writeFileSync(configPath, JSON.stringify({
    PORT: port,
    HOST: '127.0.0.1',
    DATABASE_PATH: dbPath,
    UPLOAD_DIR: path.join(tmp, 'uploads'),
    BACKUP_DIR: path.join(tmp, 'backups'),
    DEFAULT_TAX_RATE: '0.0775',
    DEFAULT_TAX_LABEL: 'Sales tax 7.75%',
  }));
  base = 'http://127.0.0.1:' + port;
  child = spawn(process.execPath, ['server/server_new.js'], {
    cwd: repo,
    env: {
      ...process.env,
      CONFIG_PATH: configPath,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATABASE_PATH: dbPath,
      UPLOAD_DIR: path.join(tmp, 'uploads'),
      BACKUP_DIR: path.join(tmp, 'backups'),
      DEFAULT_TAX_RATE: '0.0775',
      DEFAULT_TAX_LABEL: 'Sales tax 7.75%',
      TLS_KEY: '',
      TLS_CERT: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { serverLog += chunk.toString(); });
  child.stderr.on('data', (chunk) => { serverLog += chunk.toString(); });

  const deadline = Date.now() + 30000;
  let company = null;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error('server exited ' + child.exitCode + '\n' + serverLog.slice(-2000));
    }
    try {
      const res = await fetch(base + '/api/companies');
      if (res.ok) {
        const rows = await res.json();
        if (Array.isArray(rows) && rows[0] && rows[0].settings) {
          company = rows[0];
          break;
        }
      }
    } catch (e) { /* still booting */ }
    await sleep(200);
  }
  if (!company) throw new Error('company settings never ready\n' + serverLog.slice(-2000));
  assert.ok(serverLog.includes(dbPath), 'server did not open the temp database');
  closeTo(company.settings.default_tax_rate, 0.0775, 'seed default_tax_rate');

  const custDeadline = Date.now() + 20000;
  let customer = null;
  while (Date.now() < custDeadline) {
    const res = await fetch(base + '/api/customers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Default Tax Customer',
        billing_address: '1 Test Street, Irvine, CA 92602',
        company_id: 1,
      }),
    });
    if (res.status === 201) {
      customer = await res.json();
      break;
    }
    await sleep(200);
  }
  if (!customer) throw new Error('customer create failed\n' + serverLog.slice(-2000));
  customerId = customer.id;

  const prodDeadline = Date.now() + 20000;
  let product = null;
  while (Date.now() < prodDeadline) {
    const res = await fetch(base + '/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sku: 'TAX-100',
        name: 'Hundred dollar item',
        retail_price: 100,
        wholesale_price: 40,
        stock: 20,
        company_id: 1,
      }),
    });
    if (res.status === 201) {
      product = await res.json();
      break;
    }
    await sleep(200);
  }
  if (!product) throw new Error('product create failed\n' + serverLog.slice(-2000));
  productId = product.id;
});

test.after(async () => {
  await stopServer();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function lineBody(extra) {
  return {
    customer_id: customerId,
    company_id: 1,
    items: [{ product_id: productId, quantity: 1, custom_price: 100 }],
    subtotal: 100,
    discount: 0,
    shipping: 0,
    payment_method: 'Cash',
    date: '2026-11-18',
    ...extra,
  };
}

async function postJson(urlPath, body) {
  const res = await fetch(base + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
  assert.equal(res.status, 201, urlPath + ' ' + text);
  return json;
}

test('a) invoice with no tax_rate uses company default 0.0775', async () => {
  const doc = await postJson('/api/invoices', lineBody({ status: 'Pending', notes: 'omit rate' }));
  closeTo(doc.tax_rate, 0.0775, 'tax_rate');
  closeTo(doc.tax, 7.75, 'tax');
  closeTo(doc.total, 107.75, 'total');
  assert.equal(doc.tax_label, 'Sales tax 7.75%');
});

test('a-null) invoice with tax_rate null uses company default', async () => {
  const doc = await postJson('/api/invoices', lineBody({ status: 'Pending', tax_rate: null }));
  closeTo(doc.tax_rate, 0.0775, 'tax_rate');
  closeTo(doc.total, 107.75, 'total');
});

test('a-blank) invoice with tax_rate empty string uses company default', async () => {
  const doc = await postJson('/api/invoices', lineBody({ status: 'Pending', tax_rate: '' }));
  closeTo(doc.tax_rate, 0.0775, 'tax_rate');
  closeTo(doc.total, 107.75, 'total');
});

test('b) invoice with tax_rate 0 stays untaxed', async () => {
  const doc = await postJson('/api/invoices', lineBody({ status: 'Pending', tax_rate: 0 }));
  closeTo(doc.tax_rate, 0, 'tax_rate');
  closeTo(doc.tax, 0, 'tax');
  closeTo(doc.total, 100, 'total');
});

test('c) invoice with tax_rate 0.095 uses the sent rate', async () => {
  const doc = await postJson('/api/invoices', lineBody({ status: 'Pending', tax_rate: 0.095 }));
  closeTo(doc.tax_rate, 0.095, 'tax_rate');
  closeTo(doc.tax, 9.5, 'tax');
  closeTo(doc.total, 109.5, 'total');
});

test('d) estimate with no tax_rate uses company default', async () => {
  const doc = await postJson('/api/estimates', lineBody({ status: 'Pending', notes: 'estimate omit rate' }));
  closeTo(doc.tax_rate, 0.0775, 'tax_rate');
  closeTo(doc.tax, 7.75, 'tax');
  closeTo(doc.total, 107.75, 'total');
  assert.equal(doc.tax_label, 'Sales tax 7.75%');
});

test('sales receipt with no tax_rate uses company default', async () => {
  const doc = await postJson('/api/sales', lineBody({ notes: 'sale omit rate' }));
  closeTo(doc.tax_rate, 0.0775, 'tax_rate');
  closeTo(doc.total, 107.75, 'total');
  assert.equal(doc.tax_label, 'Sales tax 7.75%');
});
