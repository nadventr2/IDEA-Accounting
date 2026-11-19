/**
 * Per-company configuration for a multi-tenant-ready accounting UI.
 * Neutral defaults for a fresh install. Per-company values live in settings.
 */
const DEFAULT_TAX_RATES = [
  { id: 'exempt', label: 'Out of State / Exempt (0%)', rate: 0 },
  { id: 'ca', label: 'CA (7.75%)', rate: 0.0775 },
];

const DEFAULT_PAYMENT_METHODS = [
  'Cash', 'Card', 'PayPal', 'Amazon', 'eBay', 'Check', 'Square', 'ACH', 'Wire',
];

/** Empty template for a public / freeware release (no branding). */
function emptyCompanySettings() {
  return {
    short_name: 'My Company',
    legal_name: 'My Company',
    website: '',
    logo_path: '/logo.png',
    favicon_path: '/favicon.ico',
    address: '',
    phone: '',
    email: '',
    /** Federal employer / tax ID (e.g. EIN) — optional */
    tax_id: '',
    /** State tax / entity ID — optional */
    state_id: '',
    tax_rates: [
      { id: 'exempt', label: 'Exempt / Out of jurisdiction (0%)', rate: 0 },
      { id: 'local', label: 'Local tax (edit rate in Settings)', rate: 0 },
    ],
    default_tax_rate: 0,
    payment_methods: ['Cash', 'Card', 'Check', 'ACH'],
    receipt_footer: 'Thank you for your business.',
    features: {
      products: true,
      easycart: false,
      packing_slips: true,
      books: true,
      deposits: true,
    },
    /** Optional labels for remittance parties (empty = hide specialized UI copy) */
    party_a_label: '',
    party_b_label: '',
    notes: '',
  };
}

/** Neutral settings for a new company. */
function seedSettingsForCompany(id, row) {
  const base = emptyCompanySettings();
  const name = (row && (row.name || row.dba_name)) || "My Company";
  return {
    ...base,
    short_name: name,
    legal_name: name,
  };
}

function parseSettings(raw, id, row) {
  if (raw == null || String(raw).trim() === '') {
    return seedSettingsForCompany(id, row || {});
  }
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const seed = seedSettingsForCompany(id, row || {});
    return {
      ...seed,
      ...obj,
      features: { ...seed.features, ...(obj.features || {}) },
      tax_rates: Array.isArray(obj.tax_rates) && obj.tax_rates.length
        ? obj.tax_rates
        : seed.tax_rates,
      payment_methods: Array.isArray(obj.payment_methods) && obj.payment_methods.length
        ? obj.payment_methods
        : seed.payment_methods,
    };
  } catch (e) {
    return seedSettingsForCompany(id, row || {});
  }
}

function companyPublicView(row) {
  const settings = parseSettings(row.settings_json, row.id, row);
  return {
    id: row.id,
    name: row.name,
    dba_name: row.dba_name || '',
    industry: row.industry || '',
    bank_name: row.bank_name || '',
    created_at: row.created_at,
    settings,
    // Convenience fields for shell / PDFs
    short_name: settings.short_name || row.name,
    legal_name: settings.legal_name || row.name,
    website: settings.website || '',
    logo_path: settings.logo_path || '/logo.png',
    favicon_path: settings.favicon_path || '/favicon.ico',
    tax_id: settings.tax_id || '',
    state_id: settings.state_id || '',
    features: settings.features || {},
    tax_rates: settings.tax_rates || DEFAULT_TAX_RATES,
    payment_methods: settings.payment_methods || DEFAULT_PAYMENT_METHODS,
  };
}

function initCompanySettingsSchema(db) {
  return new Promise((resolve) => {
    // Fresh databases have no companies table yet. The rest of server_new.js
    // creates it later in the startup queue, which is too late for this seed.
    db.run(
      `CREATE TABLE IF NOT EXISTS companies (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         name TEXT NOT NULL,
         dba_name TEXT DEFAULT '',
         industry TEXT DEFAULT '',
         bank_name TEXT DEFAULT '',
         created_at TEXT DEFAULT CURRENT_TIMESTAMP,
         settings_json TEXT
       )`,
      (createErr) => {
        if (createErr) {
          console.error('[companies] create table:', createErr.message);
          return resolve();
        }
        const extraCols = [
          'dba_name TEXT',
          'industry TEXT',
          'bank_name TEXT',
          'created_at TEXT',
          'settings_json TEXT',
        ];
        const addNext = (i) => {
          if (i >= extraCols.length) return afterColumns();
          db.run(`ALTER TABLE companies ADD COLUMN ${extraCols[i]}`, () => addNext(i + 1));
        };
        addNext(0);
      }
    );
    function afterColumns() {
    db.run('ALTER TABLE companies ADD COLUMN settings_json TEXT', (err) => {
      if (err && !String(err.message).includes('duplicate column')) {
        console.error('[companies] settings_json column:', err.message);
      } else if (!err) {
        console.log('[companies] Added settings_json column');
      }
      // Ensure two companies exist; seed settings if empty
      db.all('SELECT * FROM companies ORDER BY id', [], (e2, rows) => {
        if (e2) {
          console.error('[companies] list failed:', e2.message);
          return resolve();
        }
        const list = rows || [];
        if (list.length === 0) {
          const settings = emptyCompanySettings();
          db.run(
            `INSERT INTO companies (name, dba_name, industry, bank_name, settings_json)
             VALUES (?, ?, ?, ?, ?)`,
            ['My Company', '', '', '', JSON.stringify(settings)],
            () => resolve()
          );
          return;
        }
        let pending = list.length;
        if (!pending) return resolve();
        list.forEach((row) => {
          if (row.settings_json && String(row.settings_json).trim()) {
            if (--pending === 0) resolve();
            return;
          }
          const seed = seedSettingsForCompany(row.id, row);
          db.run(
            'UPDATE companies SET settings_json = ? WHERE id = ?',
            [JSON.stringify(seed), row.id],
            (uErr) => {
              if (uErr) console.error('[companies] seed settings', row.id, uErr.message);
              else console.log('[companies] Seeded settings for company', row.id);
              if (--pending === 0) resolve();
            }
          );
        });
      });
    });
    }
  });
}

function registerCompanyRoutes(app, db) {
  app.get('/api/companies', (req, res) => {
    db.all('SELECT * FROM companies ORDER BY id', [], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json((rows || []).map(companyPublicView));
    });
  });

  app.get('/api/companies/:id', (req, res) => {
    db.get('SELECT * FROM companies WHERE id = ?', [req.params.id], (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: 'Company not found' });
      res.json(companyPublicView(row));
    });
  });

  app.put('/api/companies/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const {
      name,
      dba_name,
      industry,
      bank_name,
      settings,
    } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    db.get('SELECT * FROM companies WHERE id = ?', [id], (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: 'Company not found' });
      const merged = parseSettings(
        settings != null ? JSON.stringify(settings) : row.settings_json,
        id,
        { name, dba_name, industry, bank_name }
      );
      // If body.settings provided, trust merged object from body
      const finalSettings =
        settings && typeof settings === 'object'
          ? {
              ...parseSettings(row.settings_json, id, row),
              ...settings,
              features: {
                ...parseSettings(row.settings_json, id, row).features,
                ...(settings.features || {}),
              },
            }
          : merged;
      db.run(
        `UPDATE companies SET name = ?, dba_name = ?, industry = ?, bank_name = ?, settings_json = ?
         WHERE id = ?`,
        [
          String(name).trim(),
          dba_name != null ? String(dba_name) : row.dba_name,
          industry != null ? String(industry) : row.industry,
          bank_name != null ? String(bank_name) : row.bank_name,
          JSON.stringify(finalSettings),
          id,
        ],
        function (uErr) {
          if (uErr) return res.status(500).json({ error: uErr.message });
          db.get('SELECT * FROM companies WHERE id = ?', [id], (gErr, updated) => {
            if (gErr) return res.status(500).json({ error: gErr.message });
            res.json(companyPublicView(updated));
          });
        }
      );
    });
  });

  /** Reset one company settings to empty release template (keeps name unless body.reset_name) */
  app.post('/api/companies/:id/reset-settings', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const empty = emptyCompanySettings();
    db.get('SELECT * FROM companies WHERE id = ?', [id], (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: 'Company not found' });
      const name = req.body && req.body.reset_name ? `Company ${id}` : row.name;
      empty.legal_name = name;
      empty.short_name = name.split(/\s+/)[0] || name;
      db.run(
        'UPDATE companies SET name = ?, settings_json = ? WHERE id = ?',
        [name, JSON.stringify(empty), id],
        function (uErr) {
          if (uErr) return res.status(500).json({ error: uErr.message });
          db.get('SELECT * FROM companies WHERE id = ?', [id], (gErr, updated) => {
            if (gErr) return res.status(500).json({ error: gErr.message });
            res.json(companyPublicView(updated));
          });
        }
      );
    });
  });
}

module.exports = {
  initCompanySettingsSchema,
  registerCompanyRoutes,
  emptyCompanySettings,
  seedSettingsForCompany,
  parseSettings,
  companyPublicView,
  DEFAULT_TAX_RATES,
  DEFAULT_PAYMENT_METHODS,
};
