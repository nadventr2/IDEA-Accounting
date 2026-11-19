/**
 * Optional WP EasyCart / MySQL source.
 * Disabled unless EASYCART_ENABLED=1. No default host, user, or password.
 */
const enabled = process.env.EASYCART_ENABLED === '1' || process.env.EASYCART_ENABLED === 'true';

module.exports = {
  enabled,
  mode: (process.env.EASYCART_MODE || 'local').toLowerCase(),
  host: process.env.EASYCART_MYSQL_HOST || '',
  user: process.env.EASYCART_MYSQL_USER || '',
  password: process.env.EASYCART_MYSQL_PASSWORD || '',
  database: process.env.EASYCART_MYSQL_DATABASE || '',
  waitForConnections: true,
  connectionLimit: Number(process.env.EASYCART_MYSQL_CONNECTION_LIMIT || 4),
  queueLimit: 0,
  dateStrings: true,
  timezone: 'local',
  remoteUrl: (process.env.EASYCART_REMOTE_URL || '').replace(/\/$/, ''),
  remoteUser: process.env.EASYCART_REMOTE_USER || '',
  remotePassword: process.env.EASYCART_REMOTE_PASSWORD || '',
  remoteInsecureTls: process.env.EASYCART_REMOTE_INSECURE_TLS === '1',
  productOwner: {
    cleanStartDate: process.env.EASYCART_CLEAN_START || '',
    feeRate: Number(process.env.EASYCART_REMIT_FEE_RATE || 0),
    importOwner: process.env.EASYCART_IMPORT_OWNER || 'party_a',
  },
};
