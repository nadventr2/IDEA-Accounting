# Changelog

## 1.0.1

- Sales tax rates are set per company in Settings (label and percent, stored as a decimal).
- New companies start with "No tax (0%)" and an example row. `DEFAULT_TAX_RATE` and `DEFAULT_TAX_LABEL` seed the default.
- Invoices, estimates, and sales can pick a configured rate or type a custom percent. The document stores `tax_rate` and `tax_label`.
- PDFs, detail views, and CSV import use that document rate. A row with no label shows as Tax (x.xx%).
- EasyCart import uses the order's tax divided by the taxable amount.

## 1.0.0

- First public package of the accounting app.
- Configuration is environment variables or `config.json`.
- A new database starts empty, with one company named My Company.
- EasyCart / MySQL import is off until you set `EASYCART_ENABLED=1`.

- License: GPL-3.0-or-later (changed from MIT before first public release).
