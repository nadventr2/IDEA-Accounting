/**
 * Runtime configuration.
 * Environment variables override config.json. Relative paths are from the project root.
 */
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');

function resolvePath(value, fallback) {
  const raw = value && String(value).trim() ? String(value).trim() : fallback;
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(PROJECT_ROOT, raw);
}

function loadConfig() {
  const filePath = process.env.CONFIG_PATH
    ? path.resolve(process.env.CONFIG_PATH)
    : path.join(PROJECT_ROOT, 'config.json');
  let file = {};
  if (fs.existsSync(filePath)) {
    file = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
  const env = process.env;
  const pick = (key, fallback) => {
    if (env[key] != null && String(env[key]).trim() !== '') return env[key];
    if (file[key] != null && String(file[key]).trim() !== '') return file[key];
    return fallback;
  };
  return {
    port: Number(pick('PORT', 3003)),
    host: String(pick('HOST', '0.0.0.0')),
    databasePath: resolvePath(pick('DATABASE_PATH', ''), path.join('data', 'accounting.db')),
    backupDir: resolvePath(pick('BACKUP_DIR', ''), path.join('data', 'backups')),
    uploadDir: resolvePath(pick('UPLOAD_DIR', ''), path.join('data', 'uploads')),
    logLevel: String(pick('LOG_LEVEL', 'info')),
    tlsKey: String(pick('TLS_KEY', '') || ''),
    tlsCert: String(pick('TLS_CERT', '') || ''),
    reportTimezone: String(pick('REPORT_TIMEZONE', 'UTC')),
    defaultTaxRate: pick('DEFAULT_TAX_RATE', '0.0775'),
    defaultTaxLabel: String(pick('DEFAULT_TAX_LABEL', 'Sales tax 7.75%') || ''),
  };
}

module.exports = { loadConfig, PROJECT_ROOT };
