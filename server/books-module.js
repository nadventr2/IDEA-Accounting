/**
 * Books / full accounting module:
 * checks, owner draws, fixed assets + depreciation, loans (P&I), tax payments,
 * Party B / Party A product remittances (proceeds payables — not equity draws).
 * Wired into P&L via getBooksPnlExtras().
 */
const { DateTime } = require('luxon');

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

const DEFAULT_ACCOUNTS = [
  { code: '1000', name: 'Operating Bank Account', type: 'asset', subtype: 'bank' },
  { code: '1200', name: 'Accounts Receivable', type: 'asset', subtype: 'current' },
  { code: '1400', name: 'Prepaid Taxes', type: 'asset', subtype: 'current' },
  { code: '1450', name: 'Due from clients (reimbursable)', type: 'asset', subtype: 'current' },
  { code: '1500', name: 'Fixed Assets', type: 'asset', subtype: 'fixed' },
  { code: '1510', name: 'Accumulated Depreciation', type: 'asset', subtype: 'contra_fixed' },
  { code: '2000', name: 'Accounts Payable', type: 'liability', subtype: 'current' },
  { code: '2050', name: 'Credit Card Payable', type: 'liability', subtype: 'current' },
  { code: '2100', name: 'Vehicle / Equipment Loans', type: 'liability', subtype: 'long_term' },
  // Product remittances: gross/near-gross proceeds held for principals (NOT owner equity)
  { code: '2200', name: 'Due to Party B (product remittances)', type: 'liability', subtype: 'remittance' },
  { code: '2210', name: 'Due to Party A (product settlement)', type: 'liability', subtype: 'remittance' },
  { code: '3000', name: "Owner's Equity", type: 'equity', subtype: 'equity' },
  { code: '3100', name: "Owner's Draws", type: 'equity', subtype: 'draw' },
  { code: '3200', name: 'Owner Contributions', type: 'equity', subtype: 'contribution' },
  { code: '3500', name: 'Due to / from related company', type: 'equity', subtype: 'intercompany' },
  { code: '4000', name: 'Sales / Income', type: 'income', subtype: 'operating' },
  { code: '4100', name: 'Other Income', type: 'income', subtype: 'other' },
  { code: '5000', name: 'Cost of Goods Sold', type: 'expense', subtype: 'cogs' },
  { code: '5150', name: 'Product remittances — Party B', type: 'expense', subtype: 'remittance' },
  { code: '5160', name: 'Product remittances — Party A', type: 'expense', subtype: 'remittance' },
  { code: '6000', name: 'Operating Expenses', type: 'expense', subtype: 'operating' },
  { code: '6050', name: 'Meals (limited deduction)', type: 'expense', subtype: 'meals' },
  { code: '6100', name: 'Interest Expense', type: 'expense', subtype: 'interest' },
  { code: '6200', name: 'Depreciation Expense', type: 'expense', subtype: 'depreciation' },
  { code: '6300', name: 'Taxes (non-income)', type: 'expense', subtype: 'tax_expense' },
  { code: '7000', name: 'Estimated Income Tax Payments', type: 'expense', subtype: 'income_tax' },
];

/** Default year-end CPA checklist (per company + tax year) */
const YE_CHECKLIST_TEMPLATE = [
  { key: 'bank_statements', label: 'Bank statements (all accounts) for the year + Dec 31', group: 'documents' },
  { key: 'cc_statements', label: 'Credit card statements for the year + YE balance', group: 'documents' },
  { key: 'loan_statements', label: 'Loan statements with year-end balances', group: 'documents' },
  { key: 'prior_return', label: 'Prior-year tax return (and extension if any)', group: 'documents' },
  { key: 'est_tax_proof', label: 'Estimated / prepaid tax payment confirmations (IRS / FTB)', group: 'documents' },
  { key: 'w9s', label: 'W-9s collected for 1099 vendors', group: 'documents' },
  { key: 'sales_tax_returns', label: 'Sales tax returns filed for the year', group: 'documents' },
  { key: 'insurance', label: 'Insurance premiums / declarations (auto, liability, E&O)', group: 'documents' },
  { key: 'payroll_note', label: 'Payroll reports — or confirm “no payroll this year”', group: 'documents' },
  { key: 'mileage', label: 'Vehicle mileage log or written business-use %', group: 'documents' },
  { key: 'cash_balance', label: 'Enter year-end bank / cash balance on Balance sheet tab', group: 'books' },
  { key: 'cc_balance', label: 'Enter year-end credit card balance on Balance sheet tab', group: 'books' },
  { key: 'beg_equity', label: 'Enter beginning equity (from prior return / books)', group: 'books' },
  { key: 'inventory_count', label: 'Year-end inventory count / valuation reviewed', group: 'books' },
  { key: 'ar_review', label: 'A/R aging reviewed (write off uncollectible if needed)', group: 'books' },
  { key: 'ap_review', label: 'A/P aging reviewed (unpaid bills complete)', group: 'books' },
  { key: 'asset_docs', label: 'Fixed asset purchase docs for new capitalized items', group: 'books' },
  { key: 'intercompany', label: 'Intercompany balances disclosed / settled', group: 'books' },
  { key: 'mark_party_a_settlements', label: 'Party B product remittances + Party A vendor settlements complete for the year (Books tab)', group: 'books' },
  { key: '1099_review', label: '1099 vendor list reviewed (threshold $600)', group: 'books' },
  { key: 'cpa_package', label: 'Download CPA package JSON + P&L for the tax year', group: 'books' },
  { key: 'basis', label: 'Confirm cash vs accrual basis with CPA', group: 'books' },
];

/** Payment methods that typically feed 1099-NEC (not credit card networks) */
const FORM_1099_METHODS = new Set([
  'check',
  'zelle',
  'ach',
  'cash',
  'wire',
  'venmo',
  'paypal',
  'custom',
]);

/** Built-in payment methods (code → label). Custom ones live in payment_method_options. */
const BUILTIN_PAYMENT_METHODS = [
  { code: 'check', label: 'Check' },
  { code: 'credit_card', label: 'Credit card' },
  { code: 'zelle', label: 'Zelle' },
  { code: 'ach', label: 'ACH / bank transfer' },
  { code: 'cash', label: 'Cash' },
  { code: 'wire', label: 'Wire' },
];

function ensureColumn(db, table, column, typeSql) {
  db.all(`PRAGMA table_info(${table})`, (err, rows) => {
    if (err || !rows) return;
    if (!rows.some((r) => r.name === column)) {
      db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeSql}`, (e) => {
        if (e) console.warn(`[books] add column ${table}.${column}:`, e.message);
      });
    }
  });
}

function initBooksSchema(db) {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS gl_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      subtype TEXT,
      is_system INTEGER DEFAULT 1,
      UNIQUE(company_id, code)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS loans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      lender TEXT,
      original_principal REAL NOT NULL DEFAULT 0,
      current_balance REAL NOT NULL DEFAULT 0,
      interest_rate REAL DEFAULT 0,
      start_date TEXT,
      related_asset_id INTEGER,
      notes TEXT,
      active INTEGER DEFAULT 1
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS fixed_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      asset_type TEXT DEFAULT 'vehicle',
      purchase_date TEXT,
      purchase_cost REAL NOT NULL DEFAULT 0,
      salvage_value REAL DEFAULT 0,
      useful_life_years REAL DEFAULT 5,
      depreciation_method TEXT DEFAULT 'straight_line',
      accumulated_depreciation REAL DEFAULT 0,
      loan_id INTEGER,
      notes TEXT,
      active INTEGER DEFAULT 1
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS depreciation_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      fixed_asset_id INTEGER NOT NULL,
      period_date TEXT NOT NULL,
      amount REAL NOT NULL,
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      check_number TEXT,
      check_date TEXT NOT NULL,
      payee TEXT NOT NULL,
      amount REAL NOT NULL,
      memo TEXT,
      category TEXT NOT NULL DEFAULT 'operating_expense',
      expense_category_id INTEGER,
      expense_category_name TEXT,
      loan_id INTEGER,
      principal_amount REAL DEFAULT 0,
      interest_amount REAL DEFAULT 0,
      tax_jurisdiction TEXT,
      tax_year INTEGER,
      tax_type TEXT,
      is_prepaid_tax INTEGER DEFAULT 0,
      fixed_asset_id INTEGER,
      is_owner_draw INTEGER DEFAULT 0,
      bank_gl_code TEXT DEFAULT '1000',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS tax_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      payment_date TEXT NOT NULL,
      amount REAL NOT NULL,
      jurisdiction TEXT,
      tax_type TEXT,
      tax_year INTEGER,
      check_number TEXT,
      is_prepaid INTEGER DEFAULT 0,
      notes TEXT,
      check_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS owner_equity_tx (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      tx_date TEXT NOT NULL,
      amount REAL NOT NULL,
      tx_type TEXT NOT NULL,
      description TEXT,
      check_number TEXT,
      check_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    // Money in: Zelle reimbursements, refunds, other receipts (not sales deposits)
    db.run(`CREATE TABLE IF NOT EXISTS books_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      receipt_date TEXT NOT NULL,
      amount REAL NOT NULL,
      payer TEXT,
      payment_method TEXT DEFAULT 'zelle',
      payment_method_label TEXT,
      reference_number TEXT,
      category TEXT NOT NULL DEFAULT 'reimbursement',
      memo TEXT,
      linked_check_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    // User-defined payment methods (e.g. "Venmo", "PayPal")
    db.run(`CREATE TABLE IF NOT EXISTS payment_method_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      label TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      UNIQUE(company_id, code)
    )`);

    // Migrate existing checks table for payment method fields
    ensureColumn(db, 'checks', 'payment_method', "TEXT DEFAULT 'check'");
    ensureColumn(db, 'checks', 'payment_method_label', 'TEXT');
    ensureColumn(db, 'checks', 'reference_number', 'TEXT');
    ensureColumn(db, 'checks', 'is_reimbursable', 'INTEGER DEFAULT 0');
    ensureColumn(db, 'checks', 'is_meals', 'INTEGER DEFAULT 0');
    ensureColumn(db, 'checks', 'meals_deductible_pct', 'REAL DEFAULT 50');
    ensureColumn(db, 'checks', 'is_intercompany', 'INTEGER DEFAULT 0');
    ensureColumn(db, 'checks', 'related_company_id', 'INTEGER');

    // Vendor 1099 fields
    ensureColumn(db, 'vendors', 'tin', 'TEXT');
    ensureColumn(db, 'vendors', 'is_1099', 'INTEGER DEFAULT 1');
    ensureColumn(db, 'vendors', 'tax_name', 'TEXT');

    // Manual year-end / balance-sheet balances (cash, CC, beginning equity, …)
    db.run(`CREATE TABLE IF NOT EXISTS books_balances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      as_of_date TEXT NOT NULL,
      account_key TEXT NOT NULL,
      label TEXT,
      amount REAL NOT NULL DEFAULT 0,
      notes TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id, as_of_date, account_key)
    )`);

    // Year-end checklist progress
    db.run(`CREATE TABLE IF NOT EXISTS ye_checklist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      tax_year INTEGER NOT NULL,
      item_key TEXT NOT NULL,
      done INTEGER DEFAULT 0,
      notes TEXT,
      done_at TEXT,
      UNIQUE(company_id, tax_year, item_key)
    )`);

    // Party B / Party A product remittances (proceeds payables — not owner equity)
    // entry_type: accrue = amount becomes Due to party; payment = reduces Due to party
    db.run(`CREATE TABLE IF NOT EXISTS books_settlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      settlement_date TEXT NOT NULL,
      period_start TEXT,
      period_end TEXT,
      party TEXT NOT NULL,
      entry_type TEXT NOT NULL,
      gross_sales REAL DEFAULT 0,
      fees REAL DEFAULT 0,
      refunds REAL DEFAULT 0,
      tax_held REAL DEFAULT 0,
      amount REAL NOT NULL,
      payment_method TEXT,
      reference_number TEXT,
      check_id INTEGER,
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    // Seed accounts for both companies
    [1, 2].forEach((cid) => {
      DEFAULT_ACCOUNTS.forEach((a) => {
        db.run(
          `INSERT OR IGNORE INTO gl_accounts (company_id, code, name, type, subtype, is_system)
           VALUES (?, ?, ?, ?, ?, 1)`,
          [cid, a.code, a.name, a.type, a.subtype]
        );
      });
    });
  });
}

/** Open remittance balances by party (accrue − payment). */
async function getSettlementBalances(db, companyId, asOf) {
  const asOfClause = asOf ? ' AND date(settlement_date)<=date(?)' : '';
  const paramsBase = asOf ? [companyId, asOf] : [companyId];
  const parties = ['party_b', 'party_a'];
  const out = { mark: 0, party_a: 0, total: 0 };
  try {
    for (const party of parties) {
      const row = await dbGet(
        db,
        `SELECT
           COALESCE(SUM(CASE WHEN entry_type='accrue' THEN amount ELSE 0 END),0) AS accrued,
           COALESCE(SUM(CASE WHEN entry_type='payment' THEN amount ELSE 0 END),0) AS paid
         FROM books_settlements
         WHERE company_id=? AND party=?${asOfClause}`,
        asOf ? [companyId, party, asOf] : [companyId, party]
      );
      const bal = Math.max(0, Number(row?.accrued || 0) - Number(row?.paid || 0));
      out[party] = bal;
      out.total += bal;
    }
  } catch (_) {
    /* table may not exist yet on first boot race */
  }
  return out;
}

function ageBucket(days) {
  if (days <= 30) return 'current';
  if (days <= 60) return '31_60';
  if (days <= 90) return '61_90';
  return '90_plus';
}

function daysBetween(fromDate, toDate) {
  try {
    const a = DateTime.fromISO(String(fromDate).slice(0, 10));
    const b = DateTime.fromISO(String(toDate).slice(0, 10));
    if (!a.isValid || !b.isValid) return 0;
    return Math.max(0, Math.floor(b.diff(a, 'days').days));
  } catch (_) {
    return 0;
  }
}

async function getARAging(db, companyId, asOf) {
  const rows = await dbAll(
    db,
    `SELECT i.id, i.invoice_number, i.date, i.total, i.status, i.customer_name,
            c.name AS customer_from_join
     FROM invoices i
     LEFT JOIN customers c ON c.id = i.customer_id
     WHERE i.company_id = ?
       AND date(i.date) <= date(?)
       AND LOWER(COALESCE(i.status,'')) NOT IN ('paid','void','cancelled','canceled','converted')
     ORDER BY i.date ASC`,
    [companyId, asOf]
  );
  const buckets = { current: 0, '31_60': 0, '61_90': 0, '90_plus': 0 };
  const items = rows.map((r) => {
    const days = daysBetween(r.date, asOf);
    const bucket = ageBucket(days);
    const amount = Number(r.total || 0);
    buckets[bucket] += amount;
    return {
      id: r.id,
      invoice_number: r.invoice_number,
      date: r.date,
      customer: r.customer_name || r.customer_from_join || '—',
      status: r.status,
      amount,
      days_outstanding: days,
      bucket,
    };
  });
  return {
    as_of: asOf,
    total: Object.values(buckets).reduce((s, n) => s + n, 0),
    buckets,
    items,
    count: items.length,
  };
}

async function getAPAging(db, companyId, asOf) {
  const rows = await dbAll(
    db,
    `SELECT b.id, b.bill_number, b.invoice_number, b.amount, b.bill_date, b.due_date,
            b.paid, b.status, b.is_inventory_bill, v.name AS vendor_name
     FROM bills b
     LEFT JOIN vendors v ON v.id = b.vendor_id
     WHERE b.company_id = ?
       AND date(b.bill_date) <= date(?)
       AND COALESCE(b.paid, 0) = 0
       AND LOWER(COALESCE(b.status,'')) NOT IN ('paid','void','cancelled','canceled')
     ORDER BY COALESCE(b.due_date, b.bill_date) ASC`,
    [companyId, asOf]
  );
  const buckets = { current: 0, '31_60': 0, '61_90': 0, '90_plus': 0 };
  const items = rows.map((r) => {
    const baseDate = r.due_date || r.bill_date;
    const days = daysBetween(baseDate, asOf);
    const bucket = ageBucket(days);
    const amount = Number(r.amount || 0);
    buckets[bucket] += amount;
    return {
      id: r.id,
      bill_number: r.bill_number,
      vendor: r.vendor_name || '—',
      bill_date: r.bill_date,
      due_date: r.due_date,
      amount,
      is_inventory_bill: !!r.is_inventory_bill,
      days_outstanding: days,
      bucket,
    };
  });
  return {
    as_of: asOf,
    total: Object.values(buckets).reduce((s, n) => s + n, 0),
    buckets,
    items,
    count: items.length,
  };
}

async function getLatestBalances(db, companyId, asOf) {
  const rows = await dbAll(
    db,
    `SELECT * FROM books_balances
     WHERE company_id = ? AND date(as_of_date) <= date(?)
     ORDER BY as_of_date DESC`,
    [companyId, asOf]
  );
  const map = {};
  for (const r of rows) {
    if (!map[r.account_key]) map[r.account_key] = r;
  }
  return map;
}

async function getBalanceSheet(db, companyId, asOf) {
  const bal = await getLatestBalances(db, companyId, asOf);
  const cash = Number(bal.cash?.amount || 0);
  const creditCard = Number(bal.credit_card?.amount || 0);
  const beginningEquity = Number(bal.beginning_equity?.amount || 0);
  const otherAssets = Number(bal.other_assets?.amount || 0);
  const otherLiab = Number(bal.other_liabilities?.amount || 0);
  const salesTaxPayableManual = bal.sales_tax_payable
    ? Number(bal.sales_tax_payable.amount || 0)
    : null;

  const ar = await getARAging(db, companyId, asOf);
  const ap = await getAPAging(db, companyId, asOf);

  let inventoryValue = 0;
  try {
    const inv = await dbGet(
      db,
      `SELECT COALESCE(SUM(quantity * average_cost), 0) AS v
       FROM inventory WHERE company_id = ?`,
      [companyId]
    );
    inventoryValue = Number(inv?.v || 0);
  } catch (_) {
    inventoryValue = 0;
  }
  if (bal.inventory_override) inventoryValue = Number(bal.inventory_override.amount || 0);

  let assetsCost = 0;
  let accumDep = 0;
  try {
    const fa = await dbGet(
      db,
      `SELECT COALESCE(SUM(purchase_cost),0) AS cost,
              COALESCE(SUM(accumulated_depreciation),0) AS accum
       FROM fixed_assets WHERE company_id = ? AND active = 1`,
      [companyId]
    );
    assetsCost = Number(fa?.cost || 0);
    accumDep = Number(fa?.accum || 0);
  } catch (_) {}

  // Lifetime open reimbursable
  let reimbursableOpen = 0;
  try {
    const lifePaid = await dbGet(
      db,
      `SELECT COALESCE(SUM(amount),0) AS t FROM checks
       WHERE company_id=? AND date(check_date)<=date(?)
         AND (category='reimbursable_expense' OR is_reimbursable=1)`,
      [companyId, asOf]
    );
    const lifeRec = await dbGet(
      db,
      `SELECT COALESCE(SUM(amount),0) AS t FROM books_receipts
       WHERE company_id=? AND date(receipt_date)<=date(?) AND category='reimbursement'`,
      [companyId, asOf]
    );
    reimbursableOpen = Math.max(0, Number(lifePaid?.t || 0) - Number(lifeRec?.t || 0));
  } catch (_) {}

  let prepaidTax = 0;
  try {
    const pt = await dbGet(
      db,
      `SELECT COALESCE(SUM(amount),0) AS t FROM tax_payments
       WHERE company_id=? AND is_prepaid=1 AND date(payment_date)<=date(?)`,
      [companyId, asOf]
    );
    prepaidTax = Number(pt?.t || 0);
  } catch (_) {}

  let loanBalance = 0;
  let loans = [];
  try {
    loans = await dbAll(
      db,
      `SELECT id, name, lender, current_balance FROM loans WHERE company_id=? AND active=1`,
      [companyId]
    );
    loanBalance = loans.reduce((s, l) => s + Number(l.current_balance || 0), 0);
  } catch (_) {}

  // Equity movements through as_of
  let draws = 0;
  let contributions = 0;
  try {
    const d = await dbGet(
      db,
      `SELECT COALESCE(SUM(amount),0) AS t FROM owner_equity_tx
       WHERE company_id=? AND tx_type='draw' AND date(tx_date)<=date(?)`,
      [companyId, asOf]
    );
    const c = await dbGet(
      db,
      `SELECT COALESCE(SUM(amount),0) AS t FROM owner_equity_tx
       WHERE company_id=? AND tx_type='contribution' AND date(tx_date)<=date(?)`,
      [companyId, asOf]
    );
    draws = Number(d?.t || 0);
    contributions = Number(c?.t || 0);
    // also draws only on checks without equity_tx double-count is hard; use equity_tx + check draws without check_id in equity...
    // Add check draws that have no equity row already counted via side-effect (they create equity_tx)
  } catch (_) {}

  // Intercompany net (payments out positive = paid to related; receipts not modeled for IC)
  let intercompanyOut = 0;
  try {
    const ic = await dbGet(
      db,
      `SELECT COALESCE(SUM(amount),0) AS t FROM checks
       WHERE company_id=? AND date(check_date)<=date(?)
         AND (category='intercompany' OR is_intercompany=1)`,
      [companyId, asOf]
    );
    intercompanyOut = Number(ic?.t || 0);
  } catch (_) {}

  const totalAssets =
    cash +
    ar.total +
    inventoryValue +
    prepaidTax +
    reimbursableOpen +
    (assetsCost - accumDep) +
    otherAssets;

  const salesTaxPayable = salesTaxPayableManual != null ? salesTaxPayableManual : 0;
  const settlements = await getSettlementBalances(db, companyId, asOf);
  const dueToMark = Number(settlements.mark || 0);
  const dueToPartyA = Number(settlements.party_a || 0);
  const totalLiabilities =
    ap.total +
    creditCard +
    loanBalance +
    salesTaxPayable +
    otherLiab +
    intercompanyOut +
    dueToMark +
    dueToPartyA;

  // Equity plug so BS balances if beginning equity entered; else residual
  const equityComputed = beginningEquity + contributions - draws;
  const residualEquity = totalAssets - totalLiabilities - equityComputed;
  // If beginning equity set, residual is "retained earnings / net income plug"
  const retainedEarningsPlug = residualEquity;
  const totalEquity = equityComputed + retainedEarningsPlug;

  return {
    company_id: companyId,
    as_of: asOf,
    assets: {
      cash,
      accounts_receivable: ar.total,
      inventory: inventoryValue,
      prepaid_taxes: prepaidTax,
      due_from_clients_reimbursable: reimbursableOpen,
      fixed_assets_cost: assetsCost,
      accumulated_depreciation: accumDep,
      fixed_assets_net: assetsCost - accumDep,
      other_assets: otherAssets,
      total: totalAssets,
    },
    liabilities: {
      accounts_payable: ap.total,
      credit_card: creditCard,
      loans: loanBalance,
      loans_detail: loans,
      sales_tax_payable: salesTaxPayable,
      due_to_party_b: dueToMark,
      due_to_party_a: dueToPartyA,
      intercompany_due: intercompanyOut,
      other_liabilities: otherLiab,
      total: totalLiabilities,
    },
    equity: {
      beginning_equity: beginningEquity,
      contributions,
      draws,
      retained_earnings_plug: retainedEarningsPlug,
      total: totalEquity,
      note:
        'Retained earnings plug = Assets − Liabilities − (beginning equity + contributions − draws). Enter cash/CC/beginning equity for a meaningful statement.',
    },
    balances_used: bal,
    ar_count: ar.count,
    ap_count: ap.count,
    balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.02,
  };
}

async function get1099Report(db, companyId, year, threshold = 600) {
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;
  const checks = await dbAll(
    db,
    `SELECT * FROM checks
     WHERE company_id = ? AND check_date >= ? AND check_date <= ?
     ORDER BY payee, check_date`,
    [companyId, start, end]
  );

  const byPayee = {};
  for (const c of checks) {
    const cat = c.category || '';
    // Skip owner draws, tax, loan principal/interest (not 1099 vendor payments)
    if (cat === 'owner_draw' || cat === 'tax_payment' || cat === 'loan_payment') continue;
    if (Number(c.is_owner_draw) === 1) continue;

    const method = (c.payment_method || 'check').toLowerCase();
    // Credit card generally not 1099-NEC from payer (processor may issue 1099-K)
    if (method === 'credit_card') continue;
    const methodOk =
      FORM_1099_METHODS.has(method) ||
      !['credit_card'].includes(method); // custom codes like venmo included

    if (!methodOk && method === 'credit_card') continue;

    const payee = (c.payee || 'Unknown').trim();
    const key = payee.toLowerCase();
    if (!byPayee[key]) {
      byPayee[key] = {
        payee,
        total: 0,
        by_method: {},
        payment_count: 0,
        categories: {},
        sample_memos: [],
      };
    }
    const amt = Number(c.amount || 0);
    byPayee[key].total += amt;
    byPayee[key].payment_count += 1;
    const ml = paymentMethodLabel(c.payment_method, c.payment_method_label);
    byPayee[key].by_method[ml] = (byPayee[key].by_method[ml] || 0) + amt;
    byPayee[key].categories[cat] = (byPayee[key].categories[cat] || 0) + amt;
    if (c.memo && byPayee[key].sample_memos.length < 3) {
      byPayee[key].sample_memos.push(c.memo);
    }
  }

  // Match vendors for TIN / address
  let vendors = [];
  try {
    vendors = await dbAll(db, 'SELECT * FROM vendors WHERE company_id = ?', [companyId]);
  } catch (_) {
    vendors = [];
  }

  const all = Object.values(byPayee)
    .map((p) => {
      const v =
        vendors.find((x) => (x.name || '').trim().toLowerCase() === p.payee.toLowerCase()) ||
        null;
      return {
        ...p,
        meets_threshold: p.total >= threshold,
        vendor_id: v?.id || null,
        tin: v?.tin || null,
        address: v?.address || null,
        email: v?.email || null,
        phone: v?.phone || null,
        tax_name: v?.tax_name || v?.name || null,
        is_1099_vendor: v ? v.is_1099 !== 0 : true,
        by_method: Object.entries(p.by_method).map(([method, amount]) => ({ method, amount })),
      };
    })
    .sort((a, b) => b.total - a.total);

  const candidates = all.filter((p) => p.meets_threshold && p.is_1099_vendor !== false);
  const below = all.filter((p) => !p.meets_threshold);

  return {
    company_id: companyId,
    year,
    threshold,
    candidates,
    below_threshold: below,
    candidate_count: candidates.length,
    candidate_total: candidates.reduce((s, p) => s + p.total, 0),
    notes: [
      'Includes payments by check, Zelle, ACH, cash, wire, Venmo/PayPal/custom — excludes credit card and owner draws / tax / loan payments.',
      'Verify each payee is not a corporation exempt from 1099-NEC; collect W-9s before filing.',
      'Goods-only vendors may not require 1099; services generally do. CPA makes final call.',
    ],
  };
}

async function getYeChecklist(db, companyId, taxYear) {
  let rows = [];
  try {
    rows = await dbAll(
      db,
      'SELECT * FROM ye_checklist WHERE company_id = ? AND tax_year = ?',
      [companyId, taxYear]
    );
  } catch (_) {
    rows = [];
  }
  const byKey = {};
  rows.forEach((r) => {
    byKey[r.item_key] = r;
  });
  const items = YE_CHECKLIST_TEMPLATE.map((t) => {
    const r = byKey[t.key];
    return {
      key: t.key,
      label: t.label,
      group: t.group,
      done: r ? !!r.done : false,
      notes: r?.notes || '',
      done_at: r?.done_at || null,
    };
  });
  const doneCount = items.filter((i) => i.done).length;
  return {
    company_id: companyId,
    tax_year: taxYear,
    items,
    done_count: doneCount,
    total_count: items.length,
    pct: items.length ? Math.round((doneCount / items.length) * 100) : 0,
  };
}

function paymentMethodLabel(code, customLabel) {
  if (customLabel) return customLabel;
  const hit = BUILTIN_PAYMENT_METHODS.find((m) => m.code === code);
  return hit ? hit.label : code || 'Check';
}

/** P&L extras for a company + date range */
async function getBooksPnlExtras(db, companyId, startDate, endDate) {
  const checks = await dbAll(
    db,
    `SELECT * FROM checks WHERE company_id = ? AND check_date >= ? AND check_date <= ?`,
    [companyId, startDate, endDate]
  );

  let operatingFromChecks = 0;
  let interestExpense = 0;
  let ownerDraws = 0;
  let loanPrincipalPaid = 0;
  let taxPaymentsExpense = 0; // non-prepaid income tax treated as below-the-line
  let prepaidTaxPayments = 0;
  let assetPurchases = 0;
  let reimbursablePaid = 0; // client job costs to be recovered (not OpEx)
  let mealsExpense = 0;
  let mealsDeductible = 0;
  let intercompanyPaid = 0;
  const checkExpenseByCategory = {};
  const byPaymentMethod = {};

  for (const c of checks) {
    const amt = Number(c.amount || 0);
    const principal = Number(c.principal_amount || 0);
    const interest = Number(c.interest_amount || 0);
    const cat = c.category || 'operating_expense';
    const pm = paymentMethodLabel(c.payment_method || 'check', c.payment_method_label);
    byPaymentMethod[pm] = (byPaymentMethod[pm] || 0) + amt;

    if (cat === 'loan_payment') {
      interestExpense += interest;
      loanPrincipalPaid += principal;
      // Fees / remainder → operating
      const rem = amt - principal - interest;
      if (rem > 0.009) operatingFromChecks += rem;
    } else if (cat === 'owner_draw' || c.is_owner_draw) {
      ownerDraws += amt;
    } else if (cat === 'tax_payment') {
      if (c.is_prepaid_tax) prepaidTaxPayments += amt;
      else taxPaymentsExpense += amt;
    } else if (cat === 'asset_purchase') {
      assetPurchases += amt;
    } else if (cat === 'reimbursable_expense' || Number(c.is_reimbursable) === 1) {
      // Pass-through job cost (e.g. parts for client house) — not OpEx until unreimbursed (CPA memo)
      reimbursablePaid += amt;
    } else if (cat === 'intercompany' || Number(c.is_intercompany) === 1) {
      // between companies etc. — not operating expense; balance-sheet / equity memo
      intercompanyPaid += amt;
    } else if (cat === 'party_b_remittance' || cat === 'party_a_settlement') {
      // Cash payment of product remittance liability — not OpEx, not owner draw
      // (liability was already expensed when accrued on Settlements tab)
    } else {
      // operating_expense / other
      operatingFromChecks += amt;
      if (Number(c.is_meals) === 1 || cat === 'meals') {
        mealsExpense += amt;
        const pct = Number(c.meals_deductible_pct != null ? c.meals_deductible_pct : 50);
        mealsDeductible += amt * (pct / 100);
        checkExpenseByCategory['Meals (limited)'] =
          (checkExpenseByCategory['Meals (limited)'] || 0) + amt;
      } else {
        const key = c.expense_category_name || 'Payments / operating';
        checkExpenseByCategory[key] = (checkExpenseByCategory[key] || 0) + amt;
      }
    }
  }

  // Money in (Zelle reimbursements, refunds, other income)
  let receipts = [];
  try {
    receipts = await dbAll(
      db,
      `SELECT * FROM books_receipts WHERE company_id = ? AND receipt_date >= ? AND receipt_date <= ?`,
      [companyId, startDate, endDate]
    );
  } catch (_) {
    receipts = [];
  }

  let reimbursementsReceived = 0;
  let otherIncomeFromReceipts = 0;
  let refundsOffsetExpense = 0;
  for (const r of receipts) {
    const amt = Number(r.amount || 0);
    const cat = r.category || 'reimbursement';
    if (cat === 'reimbursement') {
      reimbursementsReceived += amt;
    } else if (cat === 'refund') {
      // Vendor/CC refund offsets operating expenses
      refundsOffsetExpense += amt;
    } else {
      // other_income, deposit_misc, etc.
      otherIncomeFromReceipts += amt;
    }
  }

  // Reimbursements clear "due from client"; excess over paid in period is other income (simple period model)
  // Full AR matching is lifetime; for P&L we show paid vs received and net open reimbursable.
  const netReimbursableOpen = Math.max(0, reimbursablePaid - reimbursementsReceived);
  const reimbursementExcessIncome = Math.max(0, reimbursementsReceived - reimbursablePaid);

  const depRows = await dbAll(
    db,
    `SELECT COALESCE(SUM(amount),0) AS total FROM depreciation_entries
     WHERE company_id = ? AND period_date >= ? AND period_date <= ?`,
    [companyId, startDate, endDate]
  );
  const depreciationExpense = Number(depRows[0]?.total || 0);

  const taxRows = await dbAll(
    db,
    `SELECT * FROM tax_payments WHERE company_id = ? AND payment_date >= ? AND payment_date <= ?`,
    [companyId, startDate, endDate]
  );
  let taxPayExpense = taxPaymentsExpense;
  let taxPayPrepaid = prepaidTaxPayments;
  for (const t of taxRows) {
    // Avoid double count if linked to a check already counted
    if (t.check_id) continue;
    if (t.is_prepaid) taxPayPrepaid += Number(t.amount || 0);
    else taxPayExpense += Number(t.amount || 0);
  }

  // Standalone draws only — check-linked draws are already counted from checks
  const drawRows = await dbAll(
    db,
    `SELECT COALESCE(SUM(amount),0) AS total FROM owner_equity_tx
     WHERE company_id = ? AND tx_type = 'draw' AND tx_date >= ? AND tx_date <= ?
       AND check_id IS NULL`,
    [companyId, startDate, endDate]
  );
  const standaloneDraws = Number(drawRows[0]?.total || 0);

  // OpEx reduced by refunds (not by reimbursements — those clear receivable)
  const operatingNet = Math.max(0, operatingFromChecks - refundsOffsetExpense);

  // Product remittances accrued (Due to Party B / Party A) — expense, not equity draws
  let markRemittanceExpense = 0;
  let party_aRemittanceExpense = 0;
  try {
    const setRows = await dbAll(
      db,
      `SELECT party, COALESCE(SUM(amount),0) AS t FROM books_settlements
       WHERE company_id=? AND entry_type='accrue'
         AND settlement_date>=? AND settlement_date<=?
       GROUP BY party`,
      [companyId, startDate, endDate]
    );
    for (const r of setRows) {
      if (r.party === 'party_b') markRemittanceExpense = Number(r.t || 0);
      if (r.party === 'party_a') party_aRemittanceExpense = Number(r.t || 0);
    }
  } catch (_) {}

  return {
    operating_from_checks: operatingNet,
    interest_expense: interestExpense,
    depreciation_expense: depreciationExpense,
    owner_draws: ownerDraws + standaloneDraws,
    loan_principal_paid: loanPrincipalPaid,
    tax_payments_expense: taxPayExpense,
    prepaid_tax_payments: taxPayPrepaid,
    asset_purchases: assetPurchases,
    reimbursable_paid: reimbursablePaid,
    reimbursements_received: reimbursementsReceived,
    reimbursable_open: netReimbursableOpen,
    reimbursement_excess_income: reimbursementExcessIncome,
    other_income_receipts: otherIncomeFromReceipts,
    refunds_offset: refundsOffsetExpense,
    party_b_remittance_expense: markRemittanceExpense,
    party_a_remittance_expense: party_aRemittanceExpense,
    product_remittances_total: markRemittanceExpense + party_aRemittanceExpense,
    check_expense_by_category: Object.entries(checkExpenseByCategory)
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount),
    payments_by_method: Object.entries(byPaymentMethod)
      .map(([method, amount]) => ({ method, amount }))
      .sort((a, b) => b.amount - a.amount),
    check_count: checks.length,
    receipt_count: receipts.length,
    meals_expense: mealsExpense,
    meals_deductible_estimate: mealsDeductible,
    intercompany_paid: intercompanyPaid,
  };
}

async function getBooksTrendsMonth(db, companyId, startDate, endDate) {
  const checks = await dbAll(
    db,
    `SELECT strftime('%Y-%m', check_date) AS month,
            category,
            COALESCE(SUM(amount),0) AS amount,
            COALESCE(SUM(principal_amount),0) AS principal,
            COALESCE(SUM(interest_amount),0) AS interest
     FROM checks
     WHERE company_id = ? AND check_date >= ? AND check_date <= ?
     GROUP BY month, category`,
    [companyId, startDate, endDate]
  );
  const dep = await dbAll(
    db,
    `SELECT strftime('%Y-%m', period_date) AS month, COALESCE(SUM(amount),0) AS amount
     FROM depreciation_entries
     WHERE company_id = ? AND period_date >= ? AND period_date <= ?
     GROUP BY month`,
    [companyId, startDate, endDate]
  );
  return { checks, depreciation: dep };
}

function registerBooksRoutes(app, db) {
  // ----- seed accounts on demand -----
  app.post('/api/books/seed-accounts', async (req, res) => {
    try {
      const company_id = Number(req.body.company_id || req.query.company_id || 1);
      for (const a of DEFAULT_ACCOUNTS) {
        await dbRun(
          db,
          `INSERT OR IGNORE INTO gl_accounts (company_id, code, name, type, subtype, is_system)
           VALUES (?, ?, ?, ?, ?, 1)`,
          [company_id, a.code, a.name, a.type, a.subtype]
        );
      }
      const rows = await dbAll(db, 'SELECT * FROM gl_accounts WHERE company_id = ? ORDER BY code', [company_id]);
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/books/accounts', async (req, res) => {
    try {
      const company_id = Number(req.query.company_id || 1);
      let rows = await dbAll(db, 'SELECT * FROM gl_accounts WHERE company_id = ? ORDER BY code', [company_id]);
      if (!rows.length) {
        for (const a of DEFAULT_ACCOUNTS) {
          await dbRun(
            db,
            `INSERT OR IGNORE INTO gl_accounts (company_id, code, name, type, subtype, is_system) VALUES (?,?,?,?,?,1)`,
            [company_id, a.code, a.name, a.type, a.subtype]
          );
        }
        rows = await dbAll(db, 'SELECT * FROM gl_accounts WHERE company_id = ? ORDER BY code', [company_id]);
      }
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ----- CHECKS -----
  app.get('/api/books/checks', async (req, res) => {
    try {
      const company_id = Number(req.query.company_id || 1);
      const { startDate, endDate } = req.query;
      let sql = 'SELECT * FROM checks WHERE company_id = ?';
      const params = [company_id];
      if (startDate && endDate) {
        sql += ' AND check_date >= ? AND check_date <= ?';
        params.push(startDate, endDate);
      }
      sql += ' ORDER BY check_date DESC, id DESC';
      res.json(await dbAll(db, sql, params));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/books/checks', async (req, res) => {
    try {
      const b = req.body || {};
      const company_id = Number(b.company_id || 1);
      if (!b.check_date || !b.payee || b.amount == null) {
        return res.status(400).json({ error: 'check_date, payee, and amount are required' });
      }
      const amount = Number(b.amount);
      const principal = Number(b.principal_amount || 0);
      const interest = Number(b.interest_amount || 0);
      const category = b.category || 'operating_expense';
      const is_owner_draw = b.is_owner_draw || category === 'owner_draw' ? 1 : 0;
      const is_prepaid_tax = b.is_prepaid_tax ? 1 : 0;
      const is_reimbursable =
        b.is_reimbursable || category === 'reimbursable_expense' ? 1 : 0;
      const is_meals = b.is_meals || category === 'meals' ? 1 : 0;
      const is_intercompany =
        b.is_intercompany || category === 'intercompany' ? 1 : 0;
      const meals_deductible_pct = Number(
        b.meals_deductible_pct != null ? b.meals_deductible_pct : 50
      );
      let payment_method = (b.payment_method || 'check').toString().trim() || 'check';
      let payment_method_label = b.payment_method_label || null;
      if (payment_method === 'custom') {
        payment_method = (b.payment_method_custom || payment_method_label || 'custom')
          .toString()
          .trim()
          .toLowerCase()
          .replace(/\s+/g, '_')
          .slice(0, 40) || 'custom';
        payment_method_label = b.payment_method_label || b.payment_method_custom || payment_method;
        // Persist custom method for dropdown
        await dbRun(
          db,
          `INSERT OR IGNORE INTO payment_method_options (company_id, code, label, active) VALUES (?,?,?,1)`,
          [company_id, payment_method, payment_method_label]
        );
      } else {
        payment_method_label = paymentMethodLabel(payment_method, payment_method_label);
      }
      const reference_number = b.reference_number || b.check_number || null;
      // Credit card payments hit CC payable (memo); checks hit bank
      const bank_gl =
        b.bank_gl_code || (payment_method === 'credit_card' ? '2050' : '1000');

      const r = await dbRun(
        db,
        `INSERT INTO checks (
          company_id, check_number, check_date, payee, amount, memo, category,
          expense_category_id, expense_category_name, loan_id, principal_amount, interest_amount,
          tax_jurisdiction, tax_year, tax_type, is_prepaid_tax, fixed_asset_id, is_owner_draw, bank_gl_code,
          payment_method, payment_method_label, reference_number, is_reimbursable,
          is_meals, meals_deductible_pct, is_intercompany, related_company_id
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          company_id,
          b.check_number || reference_number,
          b.check_date,
          b.payee,
          amount,
          b.memo || null,
          category,
          b.expense_category_id || null,
          b.expense_category_name || null,
          b.loan_id || null,
          principal,
          interest,
          b.tax_jurisdiction || null,
          b.tax_year || null,
          b.tax_type || null,
          is_prepaid_tax,
          b.fixed_asset_id || null,
          is_owner_draw,
          bank_gl,
          payment_method,
          payment_method_label,
          reference_number,
          is_reimbursable,
          is_meals,
          meals_deductible_pct,
          is_intercompany,
          b.related_company_id || null,
        ]
      );
      const checkId = r.lastID;

      // Side effects: loan balance, tax_payments, owner_equity, asset cost
      if ((category === 'loan_payment' || principal > 0) && b.loan_id) {
        await dbRun(
          db,
          `UPDATE loans SET current_balance = MAX(0, COALESCE(current_balance,0) - ?) WHERE id = ? AND company_id = ?`,
          [principal, b.loan_id, company_id]
        );
      }
      // Wire/ACH paying Party B or Party A product remittance → settlement payment (not equity)
      if (category === 'party_b_remittance' || category === 'party_a_settlement') {
        const party = category === 'party_b_remittance' ? 'party_b' : 'party_a';
        await dbRun(
          db,
          `INSERT INTO books_settlements (
            company_id, settlement_date, party, entry_type, amount,
            payment_method, reference_number, check_id, notes
          ) VALUES (?,?,?,?,?,?,?,?,?)`,
          [
            company_id,
            b.check_date,
            party,
            'payment',
            amount,
            payment_method,
            reference_number,
            checkId,
            b.memo || `Payment to ${party} (product remittance)`,
          ]
        );
      }
      if (category === 'tax_payment' || b.tax_jurisdiction) {
        await dbRun(
          db,
          `INSERT INTO tax_payments (company_id, payment_date, amount, jurisdiction, tax_type, tax_year, check_number, is_prepaid, notes, check_id)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [
            company_id,
            b.check_date,
            amount,
            b.tax_jurisdiction || 'CA',
            b.tax_type || (is_prepaid_tax ? 'prepaid' : 'estimated'),
            b.tax_year || DateTime.fromISO(b.check_date).year,
            b.check_number || null,
            is_prepaid_tax,
            b.memo || null,
            checkId,
          ]
        );
      }
      if (is_owner_draw || category === 'owner_draw') {
        await dbRun(
          db,
          `INSERT INTO owner_equity_tx (company_id, tx_date, amount, tx_type, description, check_number, check_id)
           VALUES (?,?,?,?,?,?,?)`,
          [company_id, b.check_date, amount, 'draw', b.memo || b.payee, b.check_number || null, checkId]
        );
      }
      if (category === 'asset_purchase' && b.fixed_asset_id) {
        // optional: increase asset cost
        await dbRun(
          db,
          `UPDATE fixed_assets SET purchase_cost = COALESCE(purchase_cost,0) + ? WHERE id = ? AND company_id = ?`,
          [amount, b.fixed_asset_id, company_id]
        );
      }

      const row = await dbGet(db, 'SELECT * FROM checks WHERE id = ?', [checkId]);
      res.status(201).json(row);
    } catch (e) {
      console.error('[books] POST checks', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/books/checks/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const b = req.body || {};
      const company_id = Number(b.company_id || 1);
      const existing = await dbGet(db, 'SELECT * FROM checks WHERE id = ? AND company_id = ?', [id, company_id]);
      if (!existing) return res.status(404).json({ error: 'Check not found' });

      // reverse old loan principal effect then apply new (simple approach)
      if (existing.loan_id && Number(existing.principal_amount) > 0) {
        await dbRun(
          db,
          `UPDATE loans SET current_balance = COALESCE(current_balance,0) + ? WHERE id = ? AND company_id = ?`,
          [existing.principal_amount, existing.loan_id, company_id]
        );
      }

      const amount = Number(b.amount);
      const principal = Number(b.principal_amount || 0);
      const interest = Number(b.interest_amount || 0);
      const category = b.category || existing.category;
      const is_owner_draw = b.is_owner_draw || category === 'owner_draw' ? 1 : 0;

      await dbRun(
        db,
        `UPDATE checks SET
          check_number=?, check_date=?, payee=?, amount=?, memo=?, category=?,
          expense_category_id=?, expense_category_name=?, loan_id=?, principal_amount=?, interest_amount=?,
          tax_jurisdiction=?, tax_year=?, tax_type=?, is_prepaid_tax=?, fixed_asset_id=?, is_owner_draw=?
         WHERE id=? AND company_id=?`,
        [
          b.check_number || null,
          b.check_date,
          b.payee,
          amount,
          b.memo || null,
          category,
          b.expense_category_id || null,
          b.expense_category_name || null,
          b.loan_id || null,
          principal,
          interest,
          b.tax_jurisdiction || null,
          b.tax_year || null,
          b.tax_type || null,
          b.is_prepaid_tax ? 1 : 0,
          b.fixed_asset_id || null,
          is_owner_draw,
          id,
          company_id,
        ]
      );

      if ((category === 'loan_payment' || principal > 0) && b.loan_id) {
        await dbRun(
          db,
          `UPDATE loans SET current_balance = MAX(0, COALESCE(current_balance,0) - ?) WHERE id = ? AND company_id = ?`,
          [principal, b.loan_id, company_id]
        );
      }

      const row = await dbGet(db, 'SELECT * FROM checks WHERE id = ?', [id]);
      res.json(row);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/books/checks/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const company_id = Number(req.query.company_id || 1);
      const existing = await dbGet(db, 'SELECT * FROM checks WHERE id = ? AND company_id = ?', [id, company_id]);
      if (!existing) return res.status(404).json({ error: 'Not found' });
      if (existing.loan_id && Number(existing.principal_amount) > 0) {
        await dbRun(
          db,
          `UPDATE loans SET current_balance = COALESCE(current_balance,0) + ? WHERE id = ? AND company_id = ?`,
          [existing.principal_amount, existing.loan_id, company_id]
        );
      }
      await dbRun(db, 'DELETE FROM tax_payments WHERE check_id = ?', [id]);
      await dbRun(db, 'DELETE FROM owner_equity_tx WHERE check_id = ?', [id]);
      await dbRun(db, 'DELETE FROM checks WHERE id = ? AND company_id = ?', [id, company_id]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ----- LOANS -----
  app.get('/api/books/loans', async (req, res) => {
    try {
      const company_id = Number(req.query.company_id || 1);
      res.json(await dbAll(db, 'SELECT * FROM loans WHERE company_id = ? ORDER BY active DESC, name', [company_id]));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/books/loans', async (req, res) => {
    try {
      const b = req.body || {};
      const company_id = Number(b.company_id || 1);
      if (!b.name) return res.status(400).json({ error: 'name required' });
      const orig = Number(b.original_principal || b.current_balance || 0);
      const bal = Number(b.current_balance != null ? b.current_balance : orig);
      const r = await dbRun(
        db,
        `INSERT INTO loans (company_id, name, lender, original_principal, current_balance, interest_rate, start_date, related_asset_id, notes, active)
         VALUES (?,?,?,?,?,?,?,?,?,1)`,
        [
          company_id,
          b.name,
          b.lender || null,
          orig,
          bal,
          Number(b.interest_rate || 0),
          b.start_date || null,
          b.related_asset_id || null,
          b.notes || null,
        ]
      );
      res.status(201).json(await dbGet(db, 'SELECT * FROM loans WHERE id = ?', [r.lastID]));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/books/loans/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const b = req.body || {};
      const company_id = Number(b.company_id || 1);
      await dbRun(
        db,
        `UPDATE loans SET name=?, lender=?, original_principal=?, current_balance=?, interest_rate=?, start_date=?, related_asset_id=?, notes=?, active=?
         WHERE id=? AND company_id=?`,
        [
          b.name,
          b.lender || null,
          Number(b.original_principal || 0),
          Number(b.current_balance || 0),
          Number(b.interest_rate || 0),
          b.start_date || null,
          b.related_asset_id || null,
          b.notes || null,
          b.active === 0 ? 0 : 1,
          id,
          company_id,
        ]
      );
      res.json(await dbGet(db, 'SELECT * FROM loans WHERE id = ?', [id]));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/books/loans/:id', async (req, res) => {
    try {
      await dbRun(db, 'DELETE FROM loans WHERE id = ? AND company_id = ?', [
        Number(req.params.id),
        Number(req.query.company_id || 1),
      ]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ----- FIXED ASSETS -----
  app.get('/api/books/assets', async (req, res) => {
    try {
      const company_id = Number(req.query.company_id || 1);
      const rows = await dbAll(
        db,
        `SELECT a.*, l.name AS loan_name,
           (COALESCE(a.purchase_cost,0) - COALESCE(a.accumulated_depreciation,0)) AS book_value
         FROM fixed_assets a
         LEFT JOIN loans l ON l.id = a.loan_id
         WHERE a.company_id = ?
         ORDER BY a.active DESC, a.name`,
        [company_id]
      );
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/books/assets', async (req, res) => {
    try {
      const b = req.body || {};
      const company_id = Number(b.company_id || 1);
      if (!b.name) return res.status(400).json({ error: 'name required' });
      const r = await dbRun(
        db,
        `INSERT INTO fixed_assets (
          company_id, name, asset_type, purchase_date, purchase_cost, salvage_value,
          useful_life_years, depreciation_method, accumulated_depreciation, loan_id, notes, active
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`,
        [
          company_id,
          b.name,
          b.asset_type || 'vehicle',
          b.purchase_date || null,
          Number(b.purchase_cost || 0),
          Number(b.salvage_value || 0),
          Number(b.useful_life_years || 5),
          b.depreciation_method || 'straight_line',
          Number(b.accumulated_depreciation || 0),
          b.loan_id || null,
          b.notes || null,
        ]
      );
      res.status(201).json(await dbGet(db, 'SELECT * FROM fixed_assets WHERE id = ?', [r.lastID]));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/books/assets/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const b = req.body || {};
      const company_id = Number(b.company_id || 1);
      await dbRun(
        db,
        `UPDATE fixed_assets SET name=?, asset_type=?, purchase_date=?, purchase_cost=?, salvage_value=?,
         useful_life_years=?, depreciation_method=?, accumulated_depreciation=?, loan_id=?, notes=?, active=?
         WHERE id=? AND company_id=?`,
        [
          b.name,
          b.asset_type || 'vehicle',
          b.purchase_date || null,
          Number(b.purchase_cost || 0),
          Number(b.salvage_value || 0),
          Number(b.useful_life_years || 5),
          b.depreciation_method || 'straight_line',
          Number(b.accumulated_depreciation || 0),
          b.loan_id || null,
          b.notes || null,
          b.active === 0 ? 0 : 1,
          id,
          company_id,
        ]
      );
      res.json(await dbGet(db, 'SELECT * FROM fixed_assets WHERE id = ?', [id]));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/books/assets/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const company_id = Number(req.query.company_id || 1);
      await dbRun(db, 'DELETE FROM depreciation_entries WHERE fixed_asset_id = ? AND company_id = ?', [id, company_id]);
      await dbRun(db, 'DELETE FROM fixed_assets WHERE id = ? AND company_id = ?', [id, company_id]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Monthly straight-line depreciation entry
  app.post('/api/books/assets/:id/depreciate', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const b = req.body || {};
      const company_id = Number(b.company_id || 1);
      const asset = await dbGet(db, 'SELECT * FROM fixed_assets WHERE id = ? AND company_id = ?', [id, company_id]);
      if (!asset) return res.status(404).json({ error: 'Asset not found' });

      const period_date = b.period_date || DateTime.now().toFormat('yyyy-MM-dd');
      let amount = Number(b.amount);
      if (!amount || amount <= 0) {
        const cost = Number(asset.purchase_cost || 0);
        const salvage = Number(asset.salvage_value || 0);
        const years = Number(asset.useful_life_years || 5) || 5;
        const annual = Math.max(0, (cost - salvage) / years);
        amount = annual / 12;
      }
      amount = Math.round(amount * 100) / 100;
      const book = Number(asset.purchase_cost || 0) - Number(asset.accumulated_depreciation || 0) - Number(asset.salvage_value || 0);
      if (amount > book && book >= 0) amount = Math.max(0, book);

      await dbRun(
        db,
        `INSERT INTO depreciation_entries (company_id, fixed_asset_id, period_date, amount, notes) VALUES (?,?,?,?,?)`,
        [company_id, id, period_date, amount, b.notes || 'Monthly depreciation']
      );
      await dbRun(
        db,
        `UPDATE fixed_assets SET accumulated_depreciation = COALESCE(accumulated_depreciation,0) + ? WHERE id = ?`,
        [amount, id]
      );
      res.status(201).json({
        amount,
        asset: await dbGet(db, 'SELECT * FROM fixed_assets WHERE id = ?', [id]),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/books/depreciation', async (req, res) => {
    try {
      const company_id = Number(req.query.company_id || 1);
      res.json(
        await dbAll(
          db,
          `SELECT d.*, a.name AS asset_name FROM depreciation_entries d
           LEFT JOIN fixed_assets a ON a.id = d.fixed_asset_id
           WHERE d.company_id = ? ORDER BY d.period_date DESC, d.id DESC`,
          [company_id]
        )
      );
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ----- TAX PAYMENTS (standalone, not via check) -----
  app.get('/api/books/tax-payments', async (req, res) => {
    try {
      const company_id = Number(req.query.company_id || 1);
      res.json(
        await dbAll(db, 'SELECT * FROM tax_payments WHERE company_id = ? ORDER BY payment_date DESC', [company_id])
      );
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/books/tax-payments', async (req, res) => {
    try {
      const b = req.body || {};
      const company_id = Number(b.company_id || 1);
      if (!b.payment_date || b.amount == null) {
        return res.status(400).json({ error: 'payment_date and amount required' });
      }
      const r = await dbRun(
        db,
        `INSERT INTO tax_payments (company_id, payment_date, amount, jurisdiction, tax_type, tax_year, check_number, is_prepaid, notes, check_id)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          company_id,
          b.payment_date,
          Number(b.amount),
          b.jurisdiction || 'CA',
          b.tax_type || 'estimated',
          b.tax_year || DateTime.fromISO(b.payment_date).year,
          b.check_number || null,
          b.is_prepaid ? 1 : 0,
          b.notes || null,
          b.check_id || null,
        ]
      );
      res.status(201).json(await dbGet(db, 'SELECT * FROM tax_payments WHERE id = ?', [r.lastID]));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/books/tax-payments/:id', async (req, res) => {
    try {
      await dbRun(db, 'DELETE FROM tax_payments WHERE id = ? AND company_id = ?', [
        Number(req.params.id),
        Number(req.query.company_id || 1),
      ]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ----- OWNER EQUITY -----
  app.get('/api/books/owner-equity', async (req, res) => {
    try {
      const company_id = Number(req.query.company_id || 1);
      res.json(
        await dbAll(db, 'SELECT * FROM owner_equity_tx WHERE company_id = ? ORDER BY tx_date DESC', [company_id])
      );
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/books/owner-equity', async (req, res) => {
    try {
      const b = req.body || {};
      const company_id = Number(b.company_id || 1);
      if (!b.tx_date || b.amount == null || !b.tx_type) {
        return res.status(400).json({ error: 'tx_date, amount, tx_type required' });
      }
      const r = await dbRun(
        db,
        `INSERT INTO owner_equity_tx (company_id, tx_date, amount, tx_type, description, check_number, check_id)
         VALUES (?,?,?,?,?,?,?)`,
        [
          company_id,
          b.tx_date,
          Number(b.amount),
          b.tx_type,
          b.description || null,
          b.check_number || null,
          b.check_id || null,
        ]
      );
      res.status(201).json(await dbGet(db, 'SELECT * FROM owner_equity_tx WHERE id = ?', [r.lastID]));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/books/owner-equity/:id', async (req, res) => {
    try {
      await dbRun(db, 'DELETE FROM owner_equity_tx WHERE id = ? AND company_id = ?', [
        Number(req.params.id),
        Number(req.query.company_id || 1),
      ]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ----- PAYMENT METHODS (built-in + custom) -----
  app.get('/api/books/payment-methods', async (req, res) => {
    try {
      const company_id = Number(req.query.company_id || 1);
      let custom = [];
      try {
        custom = await dbAll(
          db,
          'SELECT code, label, active FROM payment_method_options WHERE company_id=? AND active=1 ORDER BY label',
          [company_id]
        );
      } catch (_) {
        custom = [];
      }
      const list = [
        ...BUILTIN_PAYMENT_METHODS.map((m) => ({ ...m, builtin: true })),
        ...custom.map((m) => ({ code: m.code, label: m.label, builtin: false })),
      ];
      // de-dupe by code
      const seen = new Set();
      res.json(
        list.filter((m) => {
          if (seen.has(m.code)) return false;
          seen.add(m.code);
          return true;
        })
      );
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/books/payment-methods', async (req, res) => {
    try {
      const b = req.body || {};
      const company_id = Number(b.company_id || 1);
      const label = (b.label || '').toString().trim();
      if (!label) return res.status(400).json({ error: 'label required' });
      const code =
        (b.code || label)
          .toString()
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_|_$/g, '')
          .slice(0, 40) || 'custom';
      await dbRun(
        db,
        `INSERT INTO payment_method_options (company_id, code, label, active) VALUES (?,?,?,1)
         ON CONFLICT(company_id, code) DO UPDATE SET label=excluded.label, active=1`,
        [company_id, code, label]
      );
      res.status(201).json({ code, label, builtin: false });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ----- MONEY IN (receipts / Zelle reimbursements) -----
  app.get('/api/books/receipts', async (req, res) => {
    try {
      const company_id = Number(req.query.company_id || 1);
      const { startDate, endDate } = req.query;
      let sql = `SELECT r.*, c.payee AS linked_payee, c.check_date AS linked_date, c.amount AS linked_amount
                 FROM books_receipts r
                 LEFT JOIN checks c ON c.id = r.linked_check_id
                 WHERE r.company_id = ?`;
      const params = [company_id];
      if (startDate && endDate) {
        sql += ' AND r.receipt_date >= ? AND r.receipt_date <= ?';
        params.push(startDate, endDate);
      }
      sql += ' ORDER BY r.receipt_date DESC, r.id DESC';
      res.json(await dbAll(db, sql, params));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/books/receipts', async (req, res) => {
    try {
      const b = req.body || {};
      const company_id = Number(b.company_id || 1);
      if (!b.receipt_date || b.amount == null) {
        return res.status(400).json({ error: 'receipt_date and amount required' });
      }
      let payment_method = (b.payment_method || 'zelle').toString().trim() || 'zelle';
      let payment_method_label = b.payment_method_label || null;
      if (payment_method === 'custom') {
        payment_method = (b.payment_method_custom || payment_method_label || 'custom')
          .toString()
          .trim()
          .toLowerCase()
          .replace(/\s+/g, '_')
          .slice(0, 40) || 'custom';
        payment_method_label = b.payment_method_label || b.payment_method_custom || payment_method;
        await dbRun(
          db,
          `INSERT OR IGNORE INTO payment_method_options (company_id, code, label, active) VALUES (?,?,?,1)`,
          [company_id, payment_method, payment_method_label]
        );
      } else {
        payment_method_label = paymentMethodLabel(payment_method, payment_method_label);
      }
      const category = b.category || 'reimbursement';
      const r = await dbRun(
        db,
        `INSERT INTO books_receipts (
          company_id, receipt_date, amount, payer, payment_method, payment_method_label,
          reference_number, category, memo, linked_check_id
        ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          company_id,
          b.receipt_date,
          Number(b.amount),
          b.payer || null,
          payment_method,
          payment_method_label,
          b.reference_number || null,
          category,
          b.memo || null,
          b.linked_check_id || null,
        ]
      );
      res.status(201).json(await dbGet(db, 'SELECT * FROM books_receipts WHERE id = ?', [r.lastID]));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/books/receipts/:id', async (req, res) => {
    try {
      await dbRun(db, 'DELETE FROM books_receipts WHERE id = ? AND company_id = ?', [
        Number(req.params.id),
        Number(req.query.company_id || 1),
      ]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ----- MANUAL BALANCES (cash, CC, beginning equity, …) -----
  app.get('/api/books/balances', async (req, res) => {
    try {
      const company_id = Number(req.query.company_id || 1);
      const as_of = req.query.as_of || DateTime.now().toFormat('yyyy-MM-dd');
      const rows = await dbAll(
        db,
        'SELECT * FROM books_balances WHERE company_id=? ORDER BY as_of_date DESC, account_key',
        [company_id]
      );
      const latest = await getLatestBalances(db, company_id, as_of);
      res.json({ company_id, as_of, rows, latest });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/books/balances', async (req, res) => {
    try {
      const b = req.body || {};
      const company_id = Number(b.company_id || 1);
      const as_of_date = b.as_of_date || DateTime.now().toFormat('yyyy-MM-dd');
      // Accept either single {account_key, amount} or {balances: [{key, amount, label, notes}]}
      const list = Array.isArray(b.balances)
        ? b.balances
        : b.account_key
          ? [{ account_key: b.account_key, amount: b.amount, label: b.label, notes: b.notes }]
          : [];
      if (!list.length) return res.status(400).json({ error: 'balances array or account_key required' });
      for (const item of list) {
        if (!item.account_key) continue;
        await dbRun(
          db,
          `INSERT INTO books_balances (company_id, as_of_date, account_key, label, amount, notes, updated_at)
           VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)
           ON CONFLICT(company_id, as_of_date, account_key) DO UPDATE SET
             amount=excluded.amount, label=excluded.label, notes=excluded.notes, updated_at=CURRENT_TIMESTAMP`,
          [
            company_id,
            as_of_date,
            item.account_key,
            item.label || item.account_key,
            Number(item.amount || 0),
            item.notes || null,
          ]
        );
      }
      res.json({ ok: true, as_of_date, latest: await getLatestBalances(db, company_id, as_of_date) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/books/balance-sheet', async (req, res) => {
    try {
      const company_id = Number(req.query.company_id || 1);
      const as_of = req.query.as_of || DateTime.now().toFormat('yyyy-MM-dd');
      res.json(await getBalanceSheet(db, company_id, as_of));
    } catch (e) {
      console.error('[books] balance-sheet', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/books/ar-aging', async (req, res) => {
    try {
      const company_id = Number(req.query.company_id || 1);
      const as_of = req.query.as_of || DateTime.now().toFormat('yyyy-MM-dd');
      res.json(await getARAging(db, company_id, as_of));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/books/ap-aging', async (req, res) => {
    try {
      const company_id = Number(req.query.company_id || 1);
      const as_of = req.query.as_of || DateTime.now().toFormat('yyyy-MM-dd');
      res.json(await getAPAging(db, company_id, as_of));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/books/1099', async (req, res) => {
    try {
      const company_id = Number(req.query.company_id || 1);
      const year = Number(req.query.year || DateTime.now().year);
      const threshold = Number(req.query.threshold || 600);
      res.json(await get1099Report(db, company_id, year, threshold));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/books/ye-checklist', async (req, res) => {
    try {
      const company_id = Number(req.query.company_id || 1);
      const tax_year = Number(req.query.year || DateTime.now().year);
      res.json(await getYeChecklist(db, company_id, tax_year));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/books/ye-checklist', async (req, res) => {
    try {
      const b = req.body || {};
      const company_id = Number(b.company_id || 1);
      const tax_year = Number(b.tax_year || b.year || DateTime.now().year);
      const items = Array.isArray(b.items) ? b.items : b.key ? [b] : [];
      if (!items.length) return res.status(400).json({ error: 'items required' });
      for (const it of items) {
        const key = it.key || it.item_key;
        if (!key) continue;
        const done = it.done ? 1 : 0;
        await dbRun(
          db,
          `INSERT INTO ye_checklist (company_id, tax_year, item_key, done, notes, done_at)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(company_id, tax_year, item_key) DO UPDATE SET
             done=excluded.done, notes=excluded.notes, done_at=excluded.done_at`,
          [
            company_id,
            tax_year,
            key,
            done,
            it.notes || null,
            done ? DateTime.now().toISO() : null,
          ]
        );
      }
      res.json(await getYeChecklist(db, company_id, tax_year));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ----- SUMMARY for books dashboard -----
  app.get('/api/books/summary', async (req, res) => {
    try {
      const company_id = Number(req.query.company_id || 1);
      const zone = 'America/Los_Angeles';
      const now = DateTime.now().setZone(zone);
      const ytdStart = now.startOf('year').toFormat('yyyy-MM-dd');
      const today = now.toFormat('yyyy-MM-dd');
      const extras = await getBooksPnlExtras(db, company_id, ytdStart, today);
      const loans = await dbAll(db, 'SELECT COALESCE(SUM(current_balance),0) AS bal FROM loans WHERE company_id=? AND active=1', [
        company_id,
      ]);
      const assets = await dbAll(
        db,
        `SELECT COALESCE(SUM(purchase_cost),0) AS cost,
                COALESCE(SUM(accumulated_depreciation),0) AS accum
         FROM fixed_assets WHERE company_id=? AND active=1`,
        [company_id]
      );
      // Lifetime open reimbursable (all-time paid − all-time received) for dashboard AR-ish memo
      let reimbOpen = Number(extras.reimbursable_open || 0);
      try {
        const lifePaid = await dbGet(
          db,
          `SELECT COALESCE(SUM(amount),0) AS t FROM checks
           WHERE company_id=? AND (category='reimbursable_expense' OR is_reimbursable=1)`,
          [company_id]
        );
        const lifeRec = await dbGet(
          db,
          `SELECT COALESCE(SUM(amount),0) AS t FROM books_receipts
           WHERE company_id=? AND category='reimbursement'`,
          [company_id]
        );
        reimbOpen = Math.max(0, Number(lifePaid?.t || 0) - Number(lifeRec?.t || 0));
      } catch (_) {
        /* tables may still be migrating */
      }
      let settlementBal = { mark: 0, party_a: 0, total: 0 };
      try {
        settlementBal = await getSettlementBalances(db, company_id, today);
      } catch (_) {}
      res.json({
        company_id,
        ytd: extras,
        loan_balance: Number(loans[0]?.bal || 0),
        assets_cost: Number(assets[0]?.cost || 0),
        assets_book_value: Number(assets[0]?.cost || 0) - Number(assets[0]?.accum || 0),
        reimbursable_open_lifetime: reimbOpen,
        due_to_party_b: settlementBal.mark,
        due_to_party_a: settlementBal.party_a,
        settlements_open: settlementBal.total,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ----- Party B / Party A product remittances -----
  app.get('/api/books/settlements', async (req, res) => {
    try {
      const company_id = Number(req.query.company_id || 1);
      const year = req.query.year ? Number(req.query.year) : null;
      let sql = 'SELECT * FROM books_settlements WHERE company_id=?';
      const params = [company_id];
      if (year) {
        sql += ' AND strftime(\'%Y\', settlement_date)=?';
        params.push(String(year));
      }
      sql += ' ORDER BY settlement_date DESC, id DESC';
      const rows = await dbAll(db, sql, params);
      const asOf = DateTime.now().setZone('America/Los_Angeles').toFormat('yyyy-MM-dd');
      const balances = await getSettlementBalances(db, company_id, asOf);
      res.json({ settlements: rows, balances, as_of: asOf });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/books/settlements', async (req, res) => {
    try {
      const b = req.body || {};
      const company_id = Number(b.company_id || 1);
      const party = String(b.party || '').toLowerCase().trim();
      const entry_type = String(b.entry_type || '').toLowerCase().trim();
      if (!['party_b', 'party_a'].includes(party)) {
        return res.status(400).json({ error: 'party must be mark or party_a' });
      }
      if (!['accrue', 'payment'].includes(entry_type)) {
        return res.status(400).json({ error: 'entry_type must be accrue or payment' });
      }
      if (!b.settlement_date || b.amount == null) {
        return res.status(400).json({ error: 'settlement_date and amount are required' });
      }
      const amount = Number(b.amount);
      if (!(amount > 0)) {
        return res.status(400).json({ error: 'amount must be positive' });
      }

      // Optional: derive amount_due from gross − fees − refunds for accruals
      let finalAmount = amount;
      if (entry_type === 'accrue' && b.compute_from_gross) {
        const gross = Number(b.gross_sales || 0);
        const fees = Number(b.fees || 0);
        const refunds = Number(b.refunds || 0);
        finalAmount = Math.max(0, Math.round((gross - fees - refunds) * 100) / 100);
        if (!(finalAmount > 0)) {
          return res.status(400).json({ error: 'computed amount is zero — check gross/fees/refunds' });
        }
      }

      const r = await dbRun(
        db,
        `INSERT INTO books_settlements (
          company_id, settlement_date, period_start, period_end, party, entry_type,
          gross_sales, fees, refunds, tax_held, amount,
          payment_method, reference_number, notes
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          company_id,
          b.settlement_date,
          b.period_start || null,
          b.period_end || null,
          party,
          entry_type,
          Number(b.gross_sales || 0),
          Number(b.fees || 0),
          Number(b.refunds || 0),
          Number(b.tax_held || 0),
          finalAmount,
          b.payment_method || (entry_type === 'payment' ? 'ach' : null),
          b.reference_number || null,
          b.notes || null,
        ]
      );
      const row = await dbGet(db, 'SELECT * FROM books_settlements WHERE id=?', [r.lastID]);
      const balances = await getSettlementBalances(db, company_id, null);
      res.status(201).json({ settlement: row, balances });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/books/settlements/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const company_id = Number(req.query.company_id || req.body?.company_id || 1);
      await dbRun(db, 'DELETE FROM books_settlements WHERE id=? AND company_id=?', [id, company_id]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // CPA export package (JSON summary for year)
  app.get('/api/books/cpa-package', async (req, res) => {
    try {
      const company_id = Number(req.query.company_id || 1);
      const year = Number(req.query.year || DateTime.now().year);
      const startDate = `${year}-01-01`;
      const endDate = `${year}-12-31`;
      const extras = await getBooksPnlExtras(db, company_id, startDate, endDate);
      const checks = await dbAll(
        db,
        'SELECT * FROM checks WHERE company_id=? AND check_date>=? AND check_date<=? ORDER BY check_date',
        [company_id, startDate, endDate]
      );
      const loans = await dbAll(db, 'SELECT * FROM loans WHERE company_id=?', [company_id]);
      const assets = await dbAll(db, 'SELECT * FROM fixed_assets WHERE company_id=?', [company_id]);
      const dep = await dbAll(
        db,
        'SELECT * FROM depreciation_entries WHERE company_id=? AND period_date>=? AND period_date<=?',
        [company_id, startDate, endDate]
      );
      const taxes = await dbAll(
        db,
        'SELECT * FROM tax_payments WHERE company_id=? AND payment_date>=? AND payment_date<=?',
        [company_id, startDate, endDate]
      );
      const draws = await dbAll(
        db,
        'SELECT * FROM owner_equity_tx WHERE company_id=? AND tx_date>=? AND tx_date<=?',
        [company_id, startDate, endDate]
      );
      let receipts = [];
      try {
        receipts = await dbAll(
          db,
          'SELECT * FROM books_receipts WHERE company_id=? AND receipt_date>=? AND receipt_date<=? ORDER BY receipt_date',
          [company_id, startDate, endDate]
        );
      } catch (_) {
        receipts = [];
      }
      const asOf = endDate;
      const balance_sheet = await getBalanceSheet(db, company_id, asOf);
      const ar_aging = await getARAging(db, company_id, asOf);
      const ap_aging = await getAPAging(db, company_id, asOf);
      const form_1099 = await get1099Report(db, company_id, year, 600);
      const ye_checklist = await getYeChecklist(db, company_id, year);
      let settlements = [];
      try {
        settlements = await dbAll(
          db,
          'SELECT * FROM books_settlements WHERE company_id=? AND settlement_date>=? AND settlement_date<=? ORDER BY settlement_date',
          [company_id, startDate, endDate]
        );
      } catch (_) {
        settlements = [];
      }
      const settlement_balances_ye = await getSettlementBalances(db, company_id, endDate);
      res.json({
        company_id,
        year,
        range: { startDate, endDate },
        summary: extras,
        checks,
        receipts,
        loans,
        fixed_assets: assets,
        depreciation_entries: dep,
        tax_payments: taxes,
        owner_equity: draws,
        settlements,
        settlement_balances_ye,
        balance_sheet,
        ar_aging,
        ap_aging,
        form_1099,
        ye_checklist,
        notes: [
          'Owner draws are equity, not P&L expenses.',
          'Party B / Party A product remittances are LIABILITIES (Due to Party B / Due to Party A), not owner draws. Accrue sales proceeds; payments reduce the liability.',
          'Party A product stock is settled through Due to Party A, not as company inventory.',
          'Loan principal is balance sheet; interest is P&L expense.',
          'Prepaid taxes are typically prepaid assets until applied to a tax year.',
          'Depreciation method: straight-line monthly unless overridden.',
          'Client reimbursable expenses (e.g. parts on company card later repaid via Zelle) are NOT operating expenses; reimbursements clear that receivable and are NOT sales income.',
          'Payment methods include check, credit card, Zelle, ACH, cash, wire, and custom.',
          'Meals flagged payments: full amount in books; estimated deductible at meals_deductible_pct (default 50%).',
          'Intercompany payments are not operating expenses — disclose between companies transfers.',
          '1099 list excludes credit card and owner/tax/loan payments; verify corporate exemptions with W-9s.',
          'Balance sheet uses manual cash/CC/beginning equity plus AR/AP/inventory/assets/loans from the system.',
          'Give this package plus sales, bills, deposits, and bank/CC PDF statements to your CPA.',
        ],
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = {
  initBooksSchema,
  registerBooksRoutes,
  getBooksPnlExtras,
  getBooksTrendsMonth,
  getBalanceSheet,
  getARAging,
  getAPAging,
  get1099Report,
  getYeChecklist,
  getSettlementBalances,
};
