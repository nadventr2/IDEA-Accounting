/**
 * Client-side company config loader.
 * Prefers /api/companies; falls back to a neutral My Company placeholder.
 */
(function (global) {
  'use strict';

  var FALLBACK = [
    {
      id: 1,
      name: 'My Company',
      dba_name: '',
      short_name: 'My Company',
      legal_name: 'My Company',
      website: '',
      logo_path: '/logo.png',
      favicon_path: '/favicon.ico',
      industry: '',
      bank_name: '',
      tax_rates: [
        { id: 'none', label: 'No tax (0%)', rate: 0 },
        { id: 'example', label: 'Example rate (edit in Settings)', rate: 0 },
      ],
      payment_methods: ['Cash', 'Card', 'Check', 'ACH'],
      features: { products: true, easycart: false, packing_slips: true, books: true, deposits: true },
      settings: {},
    },
  ];

  var cache = null;
  var loadPromise = null;

  function apiBase() {
    var base = document.querySelector('base');
    var href = (base && base.getAttribute('href')) || '';
    if (href.indexOf('proxy/3003') !== -1) return '/api';
    return '/api';
  }

  function normalize(c) {
    if (!c) return null;
    var s = c.settings || {};
    return {
      id: Number(c.id),
      name: c.name || s.legal_name || '',
      dba_name: c.dba_name || '',
      short_name: c.short_name || s.short_name || c.name || '',
      legal_name: c.legal_name || s.legal_name || c.name || '',
      website: c.website != null ? c.website : (s.website || ''),
      logo_path: c.logo_path || s.logo_path || '/logo.png',
      favicon_path: c.favicon_path || s.favicon_path || '/favicon.ico',
      industry: c.industry || '',
      bank_name: c.bank_name || '',
      tax_rates: c.tax_rates || s.tax_rates || FALLBACK[0].tax_rates,
      payment_methods: c.payment_methods || s.payment_methods || FALLBACK[0].payment_methods,
      features: Object.assign(
        { products: true, easycart: false, packing_slips: true, books: true, deposits: true },
        c.features || s.features || {}
      ),
      settings: s,
      receipt_footer: s.receipt_footer || 'Thank you for your business.',
      party_a_label: s.party_a_label || '',
      party_b_label: s.party_b_label || '',
    };
  }

  function loadCompanies(force) {
    if (cache && !force) return Promise.resolve(cache);
    if (loadPromise && !force) return loadPromise;
    loadPromise = fetch(apiBase() + '/companies', { headers: { Accept: 'application/json' } })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (rows) {
        cache = (rows || []).map(normalize).filter(Boolean);
        if (!cache.length) cache = FALLBACK.map(normalize);
        try {
          localStorage.setItem('accounting.companies.cache', JSON.stringify(cache));
        } catch (e) { /* ignore */ }
        return cache;
      })
      .catch(function () {
        try {
          var raw = localStorage.getItem('accounting.companies.cache');
          if (raw) {
            cache = JSON.parse(raw).map(normalize);
            return cache;
          }
        } catch (e2) { /* ignore */ }
        cache = FALLBACK.map(normalize);
        return cache;
      });
    return loadPromise;
  }

  function selectedId() {
    var id = localStorage.getItem('selectedCompanyId') || '1';
    return String(id);
  }

  function getCompany(id) {
    var list = cache || FALLBACK.map(normalize);
    var sid = String(id != null ? id : selectedId());
    return list.find(function (c) { return String(c.id) === sid; }) || list[0] || normalize(FALLBACK[0]);
  }

  function hasFeature(feature, id) {
    var c = getCompany(id);
    return !!(c.features && c.features[feature]);
  }

  /** True when SKU/product line items should show (was hardcoded company_id === 1). */
  function usesProducts(id) {
    return hasFeature('products', id);
  }

  function normalizeTaxRate(rate, opts) {
    var n = Number(rate);
    if (!isFinite(n)) return 0;
    var forcePercent = opts && opts.percent;
    if (forcePercent || (n > 1 && n <= 100)) n = n / 100;
    if (n < 0) n = 0;
    if (n > 1) n = 1;
    return Math.round(n * 1000000) / 1000000;
  }

  function formatTaxPercent(rate) {
    return (normalizeTaxRate(rate) * 100).toFixed(2);
  }

  /** "Sales Tax (label)" when the document stored a label, otherwise "Tax (8.25%)". */
  function taxCaption(doc) {
    var src = doc || {};
    var raw = src.tax_rate != null ? src.tax_rate : src.taxRate;
    var label = src.tax_label != null ? src.tax_label : src.taxLabel;
    label = label != null ? String(label).trim() : '';
    if (label) return 'Sales Tax (' + label + ')';
    return 'Tax (' + formatTaxPercent(raw) + '%)';
  }

  function defaultTaxFields(companyId) {
    var c = getCompany(companyId);
    var rates = (c && c.tax_rates) || FALLBACK[0].tax_rates;
    var def = 0;
    if (c && c.settings && c.settings.default_tax_rate != null) {
      def = normalizeTaxRate(c.settings.default_tax_rate);
    }
    var idx = 0;
    for (var i = 0; i < rates.length; i++) {
      if (Math.abs(normalizeTaxRate(rates[i].rate) - def) < 0.000001) {
        idx = i;
        break;
      }
    }
    var hit = rates[idx] || { label: 'No tax (0%)', rate: 0 };
    return {
      taxRate: normalizeTaxRate(hit.rate),
      taxLabel: hit.label || '',
      taxIndex: idx,
      taxCustom: false,
      customPercent: '',
      taxTouched: false,
    };
  }

  function taxFieldsFromDoc(doc, companyId) {
    var src = doc || {};
    var rate = normalizeTaxRate(src.tax_rate != null ? src.tax_rate : src.taxRate);
    var label = String(src.tax_label || src.taxLabel || '').trim();
    var rates = (getCompany(companyId).tax_rates) || [];
    var idx = -1;
    if (label) {
      for (var i = 0; i < rates.length; i++) {
        if (String(rates[i].label || '').trim() === label) { idx = i; break; }
      }
    }
    if (idx < 0 && !label) {
      for (var j = 0; j < rates.length; j++) {
        if (Math.abs(normalizeTaxRate(rates[j].rate) - rate) < 0.000001) { idx = j; break; }
      }
    }
    if (idx >= 0) {
      return {
        taxRate: normalizeTaxRate(rates[idx].rate),
        taxLabel: rates[idx].label || '',
        taxIndex: idx,
        taxCustom: false,
        customPercent: '',
        taxTouched: true,
      };
    }
    return {
      taxRate: rate,
      taxLabel: label,
      taxIndex: -1,
      taxCustom: true,
      customPercent: (rate * 100).toFixed(2),
      taxTouched: true,
    };
  }

  function pickTax(prev, rates, value) {
    var list = rates || [];
    if (value === '__custom__') {
      var pct = prev.customPercent != null && String(prev.customPercent) !== ''
        ? String(prev.customPercent)
        : ((normalizeTaxRate(prev.taxRate) * 100).toFixed(2));
      var n = parseFloat(pct);
      return Object.assign({}, prev, {
        taxTouched: true,
        taxCustom: true,
        taxIndex: -1,
        customPercent: pct,
        taxRate: isFinite(n) ? normalizeTaxRate(Math.min(100, Math.max(0, n)), { percent: true }) : 0,
        taxLabel: '',
      });
    }
    var idx = parseInt(value, 10);
    var tr = list[idx] || { rate: 0, label: '' };
    return Object.assign({}, prev, {
      taxTouched: true,
      taxCustom: false,
      taxIndex: idx,
      taxRate: normalizeTaxRate(tr.rate),
      taxLabel: tr.label || '',
      customPercent: '',
    });
  }

  function setCustomPercent(prev, pct) {
    var n = parseFloat(pct);
    var clamped = isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
    return Object.assign({}, prev, {
      taxTouched: true,
      taxCustom: true,
      taxIndex: -1,
      customPercent: pct,
      taxRate: normalizeTaxRate(clamped, { percent: true }),
      taxLabel: '',
    });
  }

  /**
   * CSV Tax Rate cell: "8.25%" or 8.25 (percent when > 1) or 0.0825 (decimal)
   * or a label that matches a configured rate.
   */
  function parseImportTax(raw, companyId) {
    var text = raw == null ? '' : String(raw).trim();
    var rates = (getCompany(companyId).tax_rates) || [];
    if (!text) {
      var d = defaultTaxFields(companyId);
      return { tax_rate: d.taxRate, tax_label: d.taxLabel };
    }
    var percentForm = /%$/.test(text);
    var numeric = text.replace(/%$/, '').replace(/,/g, '').trim();
    if (/^-?\d+(\.\d+)?$/.test(numeric)) {
      var rate = normalizeTaxRate(numeric, { percent: percentForm });
      var match = null;
      for (var i = 0; i < rates.length; i++) {
        if (Math.abs(normalizeTaxRate(rates[i].rate) - rate) < 0.000001) { match = rates[i]; break; }
      }
      return { tax_rate: rate, tax_label: match ? (match.label || '') : '' };
    }
    var lower = text.toLowerCase();
    for (var k = 0; k < rates.length; k++) {
      if (String(rates[k].label || '').trim().toLowerCase() === lower) {
        return { tax_rate: normalizeTaxRate(rates[k].rate), tax_label: rates[k].label || '' };
      }
    }
    return { tax_rate: 0, tax_label: '' };
  }

  function taxRateOptionsHtml(id, selectedRate) {
    var c = getCompany(id);
    var rates = c.tax_rates || [];
    var sel = selectedRate != null ? Number(selectedRate) : Number(c.settings && c.settings.default_tax_rate) || 0;
    return rates
      .map(function (t) {
        var r = Number(t.rate) || 0;
        var isSel = Math.abs(r - sel) < 0.00001 ? ' selected' : '';
        return '<option value="' + r + '"' + isSel + '>' + (t.label || r) + '</option>';
      })
      .join('');
  }

  function paymentMethodOptionsHtml(id, selected) {
    var c = getCompany(id);
    var methods = c.payment_methods || [];
    return methods
      .map(function (m) {
        var isSel = m === selected ? ' selected' : '';
        return '<option value="' + m + '"' + isSel + '>' + m + '</option>';
      })
      .join('');
  }

  function taxLabel(rate, id) {
    var c = getCompany(id);
    var r = Number(rate) || 0;
    var hit = (c.tax_rates || []).find(function (t) {
      return Math.abs(Number(t.rate) - r) < 0.00001;
    });
    return hit ? hit.label : (r === 0 ? '0%' : (r * 100).toFixed(2) + '%');
  }

  global.CompanyConfig = {
    load: loadCompanies,
    get: getCompany,
    list: function () { return cache || FALLBACK.map(normalize); },
    selectedId: selectedId,
    hasFeature: hasFeature,
    usesProducts: usesProducts,
    taxRateOptionsHtml: taxRateOptionsHtml,
    paymentMethodOptionsHtml: paymentMethodOptionsHtml,
    taxLabel: taxLabel,
    normalizeTaxRate: normalizeTaxRate,
    formatTaxPercent: formatTaxPercent,
    taxCaption: taxCaption,
    defaultTaxFields: defaultTaxFields,
    taxFieldsFromDoc: taxFieldsFromDoc,
    pickTax: pickTax,
    setCustomPercent: setCustomPercent,
    parseImportTax: parseImportTax,
    apiBase: apiBase,
    FALLBACK: FALLBACK,
  };

  // Warm cache early
  loadCompanies();
})(typeof window !== 'undefined' ? window : global);
