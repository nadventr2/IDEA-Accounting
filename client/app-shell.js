/**
 * Unified accounting app header shell.
 * - Sticky header (no broken class="class"fixed hacks)
 * - Theme defaults: green=incoming, red=outgoing, blue=ops
 * - Color picker saves to localStorage (survives reboot)
 * - Company switcher + logo
 * - Nav links exclude current page; Settings always available
 */
(function () {
  'use strict';

  // Populated from /api/companies (company-config.js) with safe fallback
  var COMPANIES = {
    '1': { id: '1', name: 'Company 1', short: 'Co1', logo: '/logo.png' },
    '2': { id: '2', name: 'Company 2', short: 'Co2', logo: '/logo.png' },
  };

  function applyCompaniesFromApi(list) {
    if (!list || !list.length) return;
    var next = {};
    list.forEach(function (c) {
      next[String(c.id)] = {
        id: String(c.id),
        name: c.name || c.legal_name || ('Company ' + c.id),
        short: c.short_name || c.name || String(c.id),
        logo: c.logo_path || '/logo.png',
        favicon: c.favicon_path || '/favicon.ico',
      };
    });
    COMPANIES = next;
  }

  if (window.CompanyConfig && typeof window.CompanyConfig.load === 'function') {
    window.CompanyConfig.load().then(function (list) {
      applyCompaniesFromApi(list);
      // Refresh select labels if shell already rendered
      var sel = document.getElementById('ash-company-select');
      if (sel) {
        var cur = sel.value;
        sel.innerHTML = Object.keys(COMPANIES)
          .map(function (id) {
            return (
              '<option value="' +
              id +
              '"' +
              (id === cur ? ' selected' : '') +
              '>' +
              (COMPANIES[id].name || id) +
              '</option>'
            );
          })
          .join('');
        var logo = document.getElementById('ash-logo');
        var co = COMPANIES[cur] || COMPANIES[Object.keys(COMPANIES)[0]];
        if (logo && co) logo.src = co.logo;
      }
    });
  }

  // Theme groups → default header colors
  var THEME_DEFAULTS = {
    green: '#059669', // incoming money
    red: '#dc2626', // outgoing / pay
    blue: '#2563eb', // inventory / ops / neutral
  };

  var NAV = [
    { href: '/estimates.html', label: 'Estimates', match: ['estimates'] },
    { href: '/invoices.html', label: 'Invoices', match: ['invoices'] },
    { href: '/sales.html', label: 'Sales', match: ['sales'] },
    { href: '/wpeasycart-import.html', label: 'EasyCart Import', match: ['wpeasycart-import'] },
    { href: '/deposits.html', label: 'Deposits', match: ['deposits'] },
    { href: '/add-vendor.html', label: 'Add Vendor', match: ['add-vendor', 'vendors'] },
    { href: '/add-products.html', label: 'Products', match: ['add-products'] },
    { href: '/purchase-order.html', label: 'Purchase Order', match: ['purchase-order'] },
    { href: '/packing-slip.html', label: 'Packing Slips', match: ['packing-slip', 'packinglist'] },
    { href: '/transaction-history.html', label: 'Transactions', match: ['transaction-history'] },
    { href: '/customer-list.html', label: 'Customers', match: ['customer-list'] },
    { href: '/receive-inventory.html', label: 'Receive Inv.', match: ['receive-inventory'] },
    { href: '/inventory.html', label: 'Inventory', match: ['inventory'] },
    { href: '/bills.html', label: 'Bills', match: ['bills'] },
    { href: '/expenses.html', label: 'Expenses', match: ['expenses'] },
    { href: '/sales-tax.html', label: 'Sales Tax', match: ['sales-tax'] },
    { href: '/books.html', label: 'Books', match: ['books'] },
    { href: '/reports.html', label: 'Reports', match: ['reports'] },
  ];

  var PAGE_META = {
    sales: { title: 'Sales', theme: 'green' },
    'wpeasycart-import': { title: 'EasyCart Import', theme: 'green' },
    deposits: { title: 'Deposits', theme: 'green' },
    invoices: { title: 'Invoices', theme: 'green' },
    estimates: { title: 'Estimates', theme: 'green' },
    'transaction-history': { title: 'Transactions', theme: 'green' },
    bills: { title: 'Bills', theme: 'red' },
    expenses: { title: 'Expenses', theme: 'red' },
    'sales-tax': { title: 'Sales Tax', theme: 'red' },
    books: { title: 'Books', theme: 'red' },
    'purchase-order': { title: 'Purchase Orders', theme: 'red' },
    'add-vendor': { title: 'Vendors', theme: 'red' },
    inventory: { title: 'Inventory', theme: 'blue' },
    'receive-inventory': { title: 'Receive Inventory', theme: 'blue' },
    'add-products': { title: 'Products & services', theme: 'blue' },
    'packing-slip': { title: 'Packing Slips', theme: 'blue' },
    packinglist: { title: 'Packing Slips', theme: 'blue' },
    'customer-list': { title: 'Customers', theme: 'blue' },
    reports: { title: 'Reports', theme: 'blue' },
    index: { title: 'Home', theme: 'blue' },
    '': { title: 'Home', theme: 'blue' },
    settings: { title: 'Company Settings', theme: 'blue' },
  };

  function pageSlug() {
    var path = (location.pathname || '').split('/').pop() || '';
    return path.replace(/\.html$/i, '').toLowerCase();
  }

  function metaFor(slug) {
    return PAGE_META[slug] || { title: slug || 'Accounting', theme: 'blue' };
  }

  function companyId() {
    var keys = Object.keys(COMPANIES);
    var id = localStorage.getItem('selectedCompanyId') || keys[0] || '1';
    return COMPANIES[id] ? id : keys[0] || '1';
  }

  function ensureCompanyConfigScript(cb) {
    if (window.CompanyConfig) {
      cb();
      return;
    }
    var s = document.createElement('script');
    s.src = '/company-config.js';
    s.onload = function () { cb(); };
    s.onerror = function () { cb(); };
    document.head.appendChild(s);
  }

  var TEXT_DEFAULT = '#ffffff';

  function storageKeyColor(slug, theme) {
    // Per-page override (user preference)
    return 'accounting.headerColor.page.' + (slug || 'index');
  }

  function storageKeyTheme(theme) {
    return 'accounting.headerColor.theme.' + theme;
  }

  function storageKeyText(slug) {
    return 'accounting.headerTextColor.page.' + (slug || 'index');
  }

  function storageKeyTextTheme(theme) {
    return 'accounting.headerTextColor.theme.' + theme;
  }

  function isHex(c) {
    return typeof c === 'string' && /^#[0-9A-Fa-f]{6}$/.test(c);
  }

  function getHeaderColor(slug, theme) {
    var pageColor = localStorage.getItem(storageKeyColor(slug, theme));
    if (isHex(pageColor)) return pageColor;
    // migrate old keys
    var legacy = localStorage.getItem('headerColor_' + slug) ||
      localStorage.getItem('headerColor_' + slug.replace(/-/g, '')) ||
      localStorage.getItem('headerColor');
    if (isHex(legacy)) {
      localStorage.setItem(storageKeyColor(slug, theme), legacy);
      return legacy;
    }
    var themeColor = localStorage.getItem(storageKeyTheme(theme));
    if (isHex(themeColor)) return themeColor;
    return THEME_DEFAULTS[theme] || THEME_DEFAULTS.blue;
  }

  function setHeaderColor(slug, theme, color) {
    if (!isHex(color)) return;
    localStorage.setItem(storageKeyColor(slug, theme), color);
    // Also store as theme default so sibling pages of same type feel consistent
    localStorage.setItem(storageKeyTheme(theme), color);
  }

  function getTextColor(slug, theme) {
    var pageColor = localStorage.getItem(storageKeyText(slug));
    if (isHex(pageColor)) return pageColor;
    var legacy = localStorage.getItem('linkColor_' + slug) ||
      localStorage.getItem('linkColor_' + slug.replace(/-/g, '')) ||
      localStorage.getItem('linkColor');
    if (isHex(legacy)) {
      localStorage.setItem(storageKeyText(slug), legacy);
      return legacy;
    }
    var themeColor = localStorage.getItem(storageKeyTextTheme(theme));
    if (isHex(themeColor)) return themeColor;
    return TEXT_DEFAULT;
  }

  function setTextColor(slug, theme, color) {
    if (!isHex(color)) return;
    localStorage.setItem(storageKeyText(slug), color);
    localStorage.setItem(storageKeyTextTheme(theme), color);
  }

  function applyHeaderColors(header, bg, fg) {
    document.documentElement.style.setProperty('--app-header-bg', bg);
    document.documentElement.style.setProperty('--app-header-fg', fg);
    document.documentElement.style.setProperty('--app-accent', bg);
    header.style.background = bg;
    header.style.color = fg;
  }

  function markLegacyHeaders() {
    document.querySelectorAll('header#header, #header').forEach(function (el) {
      el.classList.add('app-legacy-header');
    });
    // Common broken inner fixed bars
    document.querySelectorAll('header .fixed, div.fixed.top-0, .fixed.top-0.left-0.w-full').forEach(function (el) {
      if (el.id === 'app-shell-header') return;
      el.classList.add('app-legacy-header');
    });
  }

  function ensureFavicon(href) {
    var url = href || '/favicon.ico';
    // bust cache when company favicon changes
    var bust = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'v=' + encodeURIComponent(companyId());
    var existing = document.querySelectorAll('link[rel="icon"], link[rel="shortcut icon"]');
    if (existing.length) {
      existing.forEach(function (el) {
        el.href = bust;
        if (/\.png(\?|$)/i.test(url)) el.type = 'image/png';
        else if (/\.webp(\?|$)/i.test(url)) el.type = 'image/webp';
        else if (/\.jpe?g(\?|$)/i.test(url)) el.type = 'image/jpeg';
        else el.type = 'image/x-icon';
      });
      return;
    }
    var link = document.createElement('link');
    link.rel = 'icon';
    link.type = /\.png(\?|$)/i.test(url) ? 'image/png' : 'image/x-icon';
    link.href = bust;
    document.head.appendChild(link);
  }

  /** Tab title + refresh legacy copyright footers */
  function applyCompanyChrome(meta) {
    var co = COMPANIES[companyId()] || {};
    var legal = co.name || 'Accounting';
    var short = co.short || legal;
    var pageTitle = (meta && meta.title) || 'Accounting';
    // Prefer live CompanyConfig favicon when available
    var fav = '/favicon.ico';
    if (window.CompanyConfig && typeof window.CompanyConfig.get === 'function') {
      var full = window.CompanyConfig.get(companyId());
      if (full && full.favicon_path) fav = full.favicon_path;
      if (full && (full.legal_name || full.name)) legal = full.legal_name || full.name;
      if (full && full.short_name) short = full.short_name;
    } else if (co.favicon) {
      fav = co.favicon;
    }
    ensureFavicon(fav);
    try {
      document.title = short + ' · ' + pageTitle;
    } catch (e) { /* ignore */ }

    // Legacy footers
    document.querySelectorAll('footer p').forEach(function (p) {
      var t = (p.textContent || '').trim();
      if (
        /All rights reserved/i.test(t) ||
        /^©/.test(t)
      ) {
        p.textContent = '© ' + legal + '. All rights reserved.';
      }
    });

    // Legacy page H1s that still say "Open Accounting"
    document.querySelectorAll('h1').forEach(function (h) {
      if (h.closest('#app-shell-header')) return;
      var t = (h.textContent || '').trim();
      if (/Open Accounting/i.test(t) || /My Company Inc\. Accounting/i.test(t)) {
        h.textContent = legal + ' Accounting';
      }
    });
  }

  function buildHeader() {
    var slug = pageSlug();
    var meta = metaFor(slug);
    var theme = meta.theme;
    var color = getHeaderColor(slug, theme);
    var textColor = getTextColor(slug, theme);
    var cid = companyId();
    var co = COMPANIES[cid];

    var header = document.createElement('header');
    header.id = 'app-shell-header';
    header.setAttribute('data-theme', theme);
    header.setAttribute('data-page', slug || 'index');

    var navHtml = NAV.filter(function (item) {
      return !(item.match && item.match.indexOf(slug) !== -1);
    })
      .map(function (item) {
        return '<a href="' + item.href + '">' + item.label + '</a>';
      })
      .join('');

    // Home gets no extra Home link; Settings always available except on settings page
    var settingsHtml =
      slug === 'settings'
        ? '<a class="ash-settings" href="/" title="Flow dashboard">⌂ Home</a>'
        : '<a class="ash-settings" href="/settings.html" title="Company settings">⚙ Settings</a>';

    header.innerHTML =
      '<div class="ash-inner">' +
      '<div class="ash-brand">' +
      '<a href="/" title="Home dashboard"><img id="ash-logo" src="' +
      co.logo +
      '" alt="Logo" /></a>' +
      '<div class="ash-brand-text">' +
      '<div class="ash-app-name">Accounting</div>' +
      '<div class="ash-page-name">' +
      meta.title +
      '</div>' +
      '</div>' +
      '</div>' +
      '<div class="ash-company">' +
      '<label for="ash-company-select">Company</label>' +
      '<select id="ash-company-select" title="Active company">' +
      Object.keys(COMPANIES)
        .map(function (id) {
          return (
            '<option value="' +
            id +
            '"' +
            (cid === id ? ' selected' : '') +
            '>' +
            (COMPANIES[id].name || id) +
            '</option>'
          );
        })
        .join('') +
      '</select>' +
      '</div>' +
      '<nav class="ash-nav" aria-label="Main">' +
      navHtml +
      '</nav>' +
      '<div class="ash-actions">' +
      settingsHtml +
      '<div class="ash-color" title="Header colors for this page (saved on this browser)">' +
      '<label for="ash-color-picker">BG</label>' +
      '<input type="color" id="ash-color-picker" value="' +
      color +
      '" title="Header background" />' +
      '<label for="ash-text-picker">Text</label>' +
      '<input type="color" id="ash-text-picker" value="' +
      textColor +
      '" title="Header text / link color" />' +
      '<button type="button" id="ash-color-reset" title="Reset background & text to theme defaults">Reset</button>' +
      '</div>' +
      '</div>' +
      '</div>';

    var spacer = document.createElement('div');
    spacer.id = 'app-shell-spacer';
    spacer.setAttribute('aria-hidden', 'true');

    // Insert at top of body
    document.body.insertBefore(spacer, document.body.firstChild);
    document.body.insertBefore(header, document.body.firstChild);
    document.body.classList.add('app-shell-on');

    function measure() {
      var h = header.offsetHeight || 72;
      document.documentElement.style.setProperty('--app-header-height', h + 'px');
      spacer.style.height = h + 'px';
    }
    measure();
    window.addEventListener('resize', measure);
    // fonts/images may change height
    setTimeout(measure, 50);
    setTimeout(measure, 300);

    applyCompanyChrome(meta);
    // Footers/titles may render after React mounts
    setTimeout(function () { applyCompanyChrome(meta); }, 200);
    setTimeout(function () { applyCompanyChrome(meta); }, 800);

    // Company change
    var sel = header.querySelector('#ash-company-select');
    sel.addEventListener('change', function () {
      var id = sel.value;
      localStorage.setItem('selectedCompanyId', id);
      var c = COMPANIES[id] || COMPANIES['1'];
      var logo = header.querySelector('#ash-logo');
      if (logo) logo.src = c.logo;
      // Notify KPI strip and any listeners
      window.dispatchEvent(new CustomEvent('accounting-company-changed', { detail: { companyId: id } }));
      if (window.AccountingKPIs && typeof window.AccountingKPIs.reload === 'function') {
        window.AccountingKPIs.reload();
      }
      // Soft reload so React pages re-fetch with new company
      // (many pages only read companyId on mount)
      location.reload();
    });

    // Background + text color pickers — persist (survive reboot)
    var picker = header.querySelector('#ash-color-picker');
    var textPicker = header.querySelector('#ash-text-picker');
    picker.addEventListener('input', function () {
      applyHeaderColors(header, picker.value, textPicker.value);
      setHeaderColor(slug, theme, picker.value);
    });
    picker.addEventListener('change', function () {
      setHeaderColor(slug, theme, picker.value);
    });
    textPicker.addEventListener('input', function () {
      applyHeaderColors(header, picker.value, textPicker.value);
      setTextColor(slug, theme, textPicker.value);
    });
    textPicker.addEventListener('change', function () {
      setTextColor(slug, theme, textPicker.value);
    });

    header.querySelector('#ash-color-reset').addEventListener('click', function () {
      localStorage.removeItem(storageKeyColor(slug, theme));
      localStorage.removeItem(storageKeyTheme(theme));
      localStorage.removeItem(storageKeyText(slug));
      localStorage.removeItem(storageKeyTextTheme(theme));
      var defBg = THEME_DEFAULTS[theme] || THEME_DEFAULTS.blue;
      var defFg = TEXT_DEFAULT;
      picker.value = defBg;
      textPicker.value = defFg;
      applyHeaderColors(header, defBg, defFg);
    });

    applyHeaderColors(header, color, textColor);

    // Move KPI mount under spacer if it was injected before us
    relocateKpiMount(header, spacer);

    return header;
  }

  function relocateKpiMount(header, spacer) {
    var kpi = document.getElementById('accounting-kpi-mount');
    if (!kpi) return;
    // Place KPI strip immediately after spacer (below fixed header in document flow)
    if (spacer.nextSibling !== kpi) {
      spacer.parentNode.insertBefore(kpi, spacer.nextSibling);
    }
  }

  function init() {
    if (document.getElementById('app-shell-header')) return;
    ensureCompanyConfigScript(function () {
      function start() {
        markLegacyHeaders();
        buildHeader();
        var obs = new MutationObserver(function () {
          var header = document.getElementById('app-shell-header');
          var spacer = document.getElementById('app-shell-spacer');
          if (header && spacer) relocateKpiMount(header, spacer);
        });
        obs.observe(document.body, { childList: true, subtree: false });
        setTimeout(function () {
          obs.disconnect();
        }, 5000);
      }
      if (window.CompanyConfig && window.CompanyConfig.load) {
        window.CompanyConfig.load()
          .then(function (list) {
            applyCompaniesFromApi(list);
            start();
          })
          .catch(start);
      } else {
        start();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.AccountingShell = {
    reload: function () {
      var old = document.getElementById('app-shell-header');
      var sp = document.getElementById('app-shell-spacer');
      if (old) old.remove();
      if (sp) sp.remove();
      document.body.classList.remove('app-shell-on');
      init();
    },
    getCompanyId: companyId,
    themes: THEME_DEFAULTS,
  };
})();
