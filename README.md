# Open Accounting

Open Accounting is a small-business ledger you run on your own computer. It covers estimates, invoices, sales, customers, vendors, products, purchase orders, packing slips, inventory, bills, expenses, deposits, sales tax, and a books module (checks, loans, assets, and a year-end checklist).

The server is Node.js and Express. Data is a SQLite file. Each company is a row you can switch in the header. There is no hosted account and no phone-home.

## Features

- Home dashboard with month and year totals
- Estimates, invoices, and sales, with PDF download
- Customers, vendors, and products
- Purchase orders, receiving, and inventory
- Packing slips
- Bills, expenses, and deposits
- Sales tax totals
- Books: payments, receipts, loans, fixed assets, owner draws, and a CPA-oriented checklist
- Optional EasyCart / MySQL order import (off by default)
- Settings for legal name, address, logo, tax rates, and payment methods

## Requirements

- Node.js 20 or newer
- npm
- A compiler toolchain is needed the first time `sqlite3` builds (`python3`, `make`, `g++` on Debian/Ubuntu)

## Quick start

```bash
tar -xzf open-accounting-1.0.0.tar.gz
cd open-accounting
npm install
cp .env.example .env
# Export the variables in .env, or copy config.example.json to config.json
export PORT=3003
export DATABASE_PATH=./data/accounting.db
npm start
```

Open http://localhost:3003

The first start creates `data/accounting.db` and one company named **My Company**. Change that name under Settings.

Fake sample rows:

```bash
# Stop the server first so SQLite is not locked, then:
npm run seed:demo
npm start
```

The seed renames the first company to Example Widgets LLC and adds Ada Example, a Demo Widget, and one sample sale. It refuses to run if customers already exist.

## Configuration

Environment variables override `config.json` in the project root. Relative paths are resolved from the project root, not the shell's current directory.

| Variable | Default | Purpose |
| --- | --- | --- |
| PORT | 3003 | HTTP port |
| HOST | 0.0.0.0 | Bind address |
| DATABASE_PATH | ./data/accounting.db | SQLite file |
| BACKUP_DIR | ./data/backups | Where you copy backups |
| UPLOAD_DIR | ./data/uploads | Logos and favicons |
| LOG_LEVEL | info | Documented for operators. Startup still prints the listen line. |
| REPORT_TIMEZONE | UTC | Reserved for report windows |
| TLS_KEY, TLS_CERT | empty | If both are set, the server speaks HTTPS |
| CONFIG_PATH | ./config.json | Alternate config file |
| EASYCART_ENABLED | unset (off) | Set to 1 to allow MySQL import |
| EASYCART_MYSQL_HOST | empty | MySQL host |
| EASYCART_MYSQL_USER | empty | MySQL user |
| EASYCART_MYSQL_PASSWORD | empty | MySQL password |
| EASYCART_MYSQL_DATABASE | empty | MySQL database |
| EASYCART_MODE | local | `local` or `remote` |
| EASYCART_REMOTE_URL | empty | Remote feed base URL |
| EASYCART_REMOTE_USER | empty | Remote feed user |
| EASYCART_REMOTE_PASSWORD | empty | Remote feed password |
| EASYCART_REMIT_FEE_RATE | 0 | Fee fraction for product remittances |
| EASYCART_CLEAN_START | empty | Optional start date for the import split |
| EASYCART_IMPORT_OWNER | party_a | `party_a` or `party_b` |

Copy `config.example.json` to `config.json` if you prefer a file. `config.json` is gitignored.

Party A and Party B are optional labels for product-proceeds owed to someone else. Set them in Settings. They are not owner draws.

## Backups

Stop the server, then copy the SQLite file:

```bash
cp ./data/accounting.db ./data/backups/accounting-$(date +%F).db
```

`BACKUP_DIR` is created on startup. The app does not upload backups anywhere.

## systemd

`deploy/open-accounting.service` is an example. Replace `accounting` and `/opt/open-accounting` with your user and path. Install Node 20, copy the app, run `npm install --omit=dev`, and create `/var/lib/open-accounting`.

```bash
sudo cp deploy/open-accounting.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now open-accounting
```

## pm2

```bash
PORT=3003 DATABASE_PATH=/var/lib/open-accounting/accounting.db pm2 start server/server_new.js --name open-accounting
```

## Docker

```bash
docker compose up --build
```

The database and uploads live in the `acct-data` volume.

## Third-party pieces

- Chart.js in `client/libs/chart.js` is Chart.js, MIT license.
- Liberation Mono in `client/fonts/` is covered by the SIL Open Font License. See `client/fonts/OFL.txt` when that file is present.
- Page scripts load React, Babel, jsPDF, and SheetJS from public CDNs. Those requests need network access in the browser.

## License

Open Accounting is free software licensed under the GNU General Public License, version 3 or (at your option) any later version (GPL-3.0-or-later). Copyright Open Accounting contributors. See `LICENSE` for the full text. If you distribute a modified version, you must release your changes under the same license and make the source available.
