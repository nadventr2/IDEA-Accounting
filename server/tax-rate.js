/**
 * Sales-tax rates are decimals (0.0825 = 8.25%).
 * A number greater than 1 and at most 100 is a percent and is stored as a decimal.
 */

function roundMoney(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

function normalizeTaxRate(rate, opts) {
  let n = Number(rate);
  if (!Number.isFinite(n)) return 0;
  const forcePercent = opts && opts.percent;
  if (forcePercent || (n > 1 && n <= 100)) n = n / 100;
  if (n < 0) n = 0;
  if (n > 1) n = 1;
  return Math.round(n * 1e6) / 1e6;
}

function rateIsAcceptable(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 100;
}

function sanitizeTaxRates(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item !== 'object') return null;
    const label = String(item.label || '').trim();
    if (!label) return null;
    if (!rateIsAcceptable(item.rate)) return null;
    out.push({
      id: item.id ? String(item.id) : 'r' + i,
      label,
      rate: normalizeTaxRate(item.rate),
    });
  }
  return out;
}

/**
 * Tax is subtotal × rate. Shipping is not taxed. Discount is not taken out of the tax base.
 * Totals are rounded to cents.
 */
function applyDocumentTax(body) {
  const src = body || {};
  const hasRate = src.tax_rate != null && src.tax_rate !== '';
  const subtotal = roundMoney(src.subtotal);
  const shipping = roundMoney(src.shipping);
  const discount = roundMoney(src.discount);
  let tax_rate;
  if (hasRate) {
    tax_rate = normalizeTaxRate(src.tax_rate);
  } else if (subtotal > 0 && src.tax != null && src.tax !== '') {
    tax_rate = rateFromTaxAmount(src.tax, subtotal);
    if (tax_rate == null) tax_rate = 0;
  } else {
    tax_rate = 0;
  }
  const tax = hasRate || src.tax == null || src.tax === ''
    ? roundMoney(subtotal * tax_rate)
    : roundMoney(src.tax);
  let total = roundMoney(subtotal + tax + shipping - discount);
  if (total < 0) total = 0;
  const rawLabel = src.tax_label != null ? String(src.tax_label).trim() : '';
  return {
    subtotal,
    tax,
    tax_rate,
    tax_label: rawLabel || null,
    shipping,
    discount,
    total,
  };
}

/** Order tax ÷ taxable merchandise. Null when there is tax but no base to divide. */
function rateFromTaxAmount(tax, taxable) {
  const t = Number(tax) || 0;
  const base = Number(taxable) || 0;
  if (t <= 0.0001) return 0;
  if (base <= 0.0001) return null;
  return normalizeTaxRate(t / base);
}

module.exports = {
  roundMoney,
  normalizeTaxRate,
  rateIsAcceptable,
  sanitizeTaxRates,
  applyDocumentTax,
  rateFromTaxAmount,
};
