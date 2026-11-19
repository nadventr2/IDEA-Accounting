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
        { id: 'exempt', label: 'Exempt (0%)', rate: 0 },
        { id: 'local', label: 'Local tax (edit rate in Settings)', rate: 0 },
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
    apiBase: apiBase,
    FALLBACK: FALLBACK,
  };

  // Warm cache early
  loadCompanies();
})(typeof window !== 'undefined' ? window : global);
