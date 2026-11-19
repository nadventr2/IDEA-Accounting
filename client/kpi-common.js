/**
 * Accounting KPI summary bubbles — auto-loads on pages that include this script.
 * Detects page from pathname (or data-kpi-page on the script tag).
 */
(function () {
  'use strict';

  function money(n) {
    var v = Number(n || 0);
    var abs = Math.abs(v);
    var s = abs >= 100000
      ? abs.toLocaleString(undefined, { maximumFractionDigits: 0 })
      : abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (v < 0 ? '-$' : '$') + s;
  }

  function num(n) {
    return Number(n || 0).toLocaleString();
  }

  function companyId() {
    return localStorage.getItem('selectedCompanyId') || '1';
  }

  function pageKey() {
    var script = document.currentScript || document.querySelector('script[src*="kpi-common.js"]');
    if (script && script.getAttribute('data-kpi-page')) {
      return script.getAttribute('data-kpi-page');
    }
    var path = (location.pathname || '').split('/').pop() || '';
    path = path.replace(/\.html$/i, '').toLowerCase();
    if (!path || path === '' || path === 'index') return 'settings';
    if (path === 'customer-list') return 'customers';
    if (path === 'purchase-order') return 'purchase_orders';
    if (path === 'add-products') return 'products';
    if (path === 'add-vendor') return 'vendors';
    if (path === 'receive-inventory') return 'receive';
    if (path === 'packing-slip' || path === 'packinglist') return 'packing';
    if (path === 'transaction-history') return 'transactions';
    if (path === 'sales-tax') return 'sales_tax';
    return path;
  }

  /** @returns {{label:string,value:string,sub?:string,cls?:string}[]} */
  function bubblesFor(page, k) {
    switch (page) {
      case 'sales':
        return [
          { label: 'Sales MTD', value: money(k.sales.mtd_total), sub: num(k.sales.mtd_count) + ' transactions', cls: 'green' },
          { label: 'Sales YTD', value: money(k.sales.ytd_total), sub: num(k.sales.ytd_count) + ' transactions', cls: '' },
          { label: 'Avg sale (MTD)', value: money(k.sales.avg_mtd), sub: 'This month', cls: 'gray' },
          { label: 'Tax collected YTD', value: money(k.sales.ytd_tax), sub: 'On receipts', cls: 'amber' },
          { label: 'All-time sales', value: money(k.sales.all_total), sub: num(k.sales.all_count) + ' total', cls: 'gray' },
          { label: 'Last sale', value: k.sales.last ? money(k.sales.last.total) : '—', sub: k.sales.last ? (k.sales.last.date + ' · ' + (k.sales.last.transaction_number || '')) : 'None', cls: 'purple' },
        ];
      case 'bills':
        return [
          { label: 'Unpaid bills', value: money(k.bills.unpaid_total), sub: num(k.bills.unpaid_count) + ' open', cls: k.bills.unpaid_count ? 'red' : 'green' },
          { label: 'Paid (all)', value: money(k.bills.paid_total), sub: num(k.bills.paid_count) + ' paid', cls: 'green' },
          { label: 'Bills this month', value: money(k.bills.mtd_total), sub: num(k.bills.mtd_count) + ' entered', cls: '' },
          { label: 'Vendors', value: num(k.vendors.count), sub: 'On file', cls: 'gray' },
        ];
      case 'customers':
        return [
          { label: 'Customers', value: num(k.customers.count), sub: 'Company #' + k.company_id, cls: '' },
          { label: 'Sales YTD', value: money(k.sales.ytd_total), sub: num(k.sales.ytd_count) + ' sales', cls: 'green' },
          { label: 'Deposits YTD', value: money(k.deposits.ytd_total), sub: num(k.deposits.ytd_count) + ' deposits', cls: 'purple' },
          { label: 'Income YTD', value: money(k.income_ytd), sub: 'Sales + deposits', cls: 'green' },
        ];
      case 'purchase_orders':
      case 'purchase-order':
        return [
          { label: 'Open / active POs', value: num(k.purchase_orders.open), sub: 'Pending + approved', cls: k.purchase_orders.open ? 'amber' : 'green' },
          { label: 'Received', value: num(k.purchase_orders.received), sub: 'Completed receipts', cls: 'green' },
          { label: 'Total POs', value: num(k.purchase_orders.total), sub: 'All statuses', cls: 'gray' },
          { label: 'Vendors', value: num(k.vendors.count), sub: 'On file', cls: '' },
        ];
      case 'invoices':
        return [
          { label: 'Open invoices', value: money(k.invoices.open_total), sub: num(k.invoices.open_count) + ' unpaid (excl. Paid/Converted)', cls: k.invoices.open_count ? 'amber' : 'green' },
          { label: 'Invoice count', value: num(k.invoices.total_count), sub: 'All statuses', cls: 'gray' },
          { label: 'Sales MTD', value: money(k.sales.mtd_total), sub: num(k.sales.mtd_count) + ' sales', cls: 'green' },
          { label: 'Customers', value: num(k.customers.count), sub: 'On file', cls: '' },
        ];
      case 'estimates':
        return [
          { label: 'Estimates', value: num(k.estimates.total_count), sub: 'All statuses', cls: '' },
          { label: 'Open estimate $', value: money(k.estimates.open_value), sub: 'Pending / open', cls: 'amber' },
          { label: 'Sales YTD', value: money(k.sales.ytd_total), sub: 'Converted pipeline', cls: 'green' },
          { label: 'Customers', value: num(k.customers.count), sub: 'On file', cls: 'gray' },
        ];
      case 'transactions':
      case 'transaction-history':
        return [
          { label: 'Sales MTD', value: money(k.sales.mtd_total), sub: num(k.sales.mtd_count) + ' txns', cls: 'green' },
          { label: 'Sales YTD', value: money(k.sales.ytd_total), sub: num(k.sales.ytd_count) + ' txns', cls: '' },
          { label: 'Deposits YTD', value: money(k.deposits.ytd_total), sub: num(k.deposits.ytd_count) + ' deposits', cls: 'purple' },
          { label: 'Last sale', value: k.sales.last ? money(k.sales.last.total) : '—', sub: k.sales.last ? k.sales.last.date : 'None', cls: 'gray' },
        ];
      case 'sales_tax':
      case 'sales-tax':
        return [
          { label: 'Tax MTD', value: money(k.sales.mtd_tax), sub: 'Collected this month', cls: 'amber' },
          { label: 'Tax YTD', value: money(k.sales.ytd_tax), sub: 'Collected this year', cls: '' },
          { label: 'Sales YTD', value: money(k.sales.ytd_total), sub: 'Taxable base (gross)', cls: 'green' },
          { label: 'Sales MTD', value: money(k.sales.mtd_total), sub: num(k.sales.mtd_count) + ' sales', cls: 'gray' },
        ];
      case 'packing':
      case 'packing-slip':
        return [
          { label: 'Packing slips', value: num(k.packing_slips.count), sub: 'On file', cls: '' },
          { label: 'Sales MTD', value: money(k.sales.mtd_total), sub: num(k.sales.mtd_count) + ' sales', cls: 'green' },
          { label: 'Open POs', value: num(k.purchase_orders.open), sub: 'Pending receipt / ship', cls: 'amber' },
          { label: 'Products', value: num(k.products.count), sub: num(k.products.units) + ' units on hand', cls: 'gray' },
        ];
      case 'deposits':
        return [
          { label: 'Deposits MTD', value: money(k.deposits.mtd_total), sub: num(k.deposits.mtd_count) + ' entries', cls: 'green' },
          { label: 'Deposits YTD', value: money(k.deposits.ytd_total), sub: num(k.deposits.ytd_count) + ' entries', cls: '' },
          { label: 'All deposits', value: money(k.deposits.all_total), sub: num(k.deposits.all_count) + ' total', cls: 'purple' },
          { label: 'Last deposit', value: k.deposits.last ? money(k.deposits.last.amount) : '—', sub: k.deposits.last ? (k.deposits.last.date + (k.deposits.last.description ? ' · ' + k.deposits.last.description : '')) : 'None', cls: 'gray' },
        ];
      case 'expenses':
        return [
          { label: 'Expenses MTD', value: money(k.expenses.mtd_total), sub: num(k.expenses.mtd_count) + ' entries', cls: 'amber' },
          { label: 'Expenses YTD', value: money(k.expenses.ytd_total), sub: num(k.expenses.ytd_count) + ' entries', cls: 'red' },
          { label: 'Unpaid bills', value: money(k.bills.unpaid_total), sub: num(k.bills.unpaid_count) + ' open', cls: k.bills.unpaid_count ? 'red' : 'green' },
          { label: 'Income YTD', value: money(k.income_ytd), sub: 'Sales + deposits', cls: 'green' },
        ];
      case 'products':
      case 'add-products':
      case 'inventory':
        return [
          { label: 'SKUs', value: num(k.products.count), sub: 'Products', cls: '' },
          { label: 'Units on hand', value: num(k.products.units), sub: 'All stock', cls: 'green' },
          { label: 'Inventory at cost', value: money(k.products.cost_value), sub: 'Wholesale × qty', cls: '' },
          { label: 'Low stock', value: num(k.products.low_stock), sub: '1–5 units', cls: 'amber' },
          { label: 'Out of stock', value: num(k.products.out_of_stock), sub: 'Zero on hand', cls: 'red' },
        ];
      case 'vendors':
      case 'add-vendor':
        return [
          { label: 'Vendors', value: num(k.vendors.count), sub: 'On file', cls: '' },
          { label: 'Open POs', value: num(k.purchase_orders.open), sub: 'Pending / approved', cls: 'amber' },
          { label: 'Unpaid bills', value: money(k.bills.unpaid_total), sub: num(k.bills.unpaid_count) + ' open', cls: k.bills.unpaid_count ? 'red' : 'green' },
          { label: 'Bills MTD', value: money(k.bills.mtd_total), sub: num(k.bills.mtd_count) + ' entered', cls: 'gray' },
        ];
      case 'receive':
      case 'receive-inventory':
        return [
          { label: 'Open POs', value: num(k.purchase_orders.open), sub: 'Awaiting receipt', cls: 'amber' },
          { label: 'Received POs', value: num(k.purchase_orders.received), sub: 'Completed', cls: 'green' },
          { label: 'Inventory value', value: money(k.products.cost_value), sub: num(k.products.units) + ' units', cls: '' },
          { label: 'Low / out', value: num(k.products.low_stock + k.products.out_of_stock), sub: num(k.products.low_stock) + ' low · ' + num(k.products.out_of_stock) + ' out', cls: 'red' },
        ];
      case 'reports':
        return [
          { label: 'Income MTD', value: money(k.income_mtd), sub: 'Sales + deposits', cls: 'green' },
          { label: 'Income YTD', value: money(k.income_ytd), sub: 'Sales + deposits', cls: '' },
          { label: 'Expenses YTD', value: money(k.expenses.ytd_total + k.bills.mtd_total), sub: 'Expenses + bills MTD note', cls: 'amber' },
          { label: 'Unpaid bills', value: money(k.bills.unpaid_total), sub: num(k.bills.unpaid_count) + ' open', cls: 'red' },
        ];
      case 'settings':
      case 'index':
      default:
        return [
          { label: 'Income MTD', value: money(k.income_mtd), sub: 'Sales + deposits', cls: 'green' },
          { label: 'Income YTD', value: money(k.income_ytd), sub: 'Year to date', cls: '' },
          { label: 'Sales YTD', value: money(k.sales.ytd_total), sub: num(k.sales.ytd_count) + ' sales', cls: 'gray' },
          { label: 'Deposits YTD', value: money(k.deposits.ytd_total), sub: num(k.deposits.ytd_count) + ' deposits', cls: 'purple' },
          { label: 'Unpaid bills', value: money(k.bills.unpaid_total), sub: num(k.bills.unpaid_count) + ' open', cls: k.bills.unpaid_count ? 'red' : 'green' },
          { label: 'Open POs', value: num(k.purchase_orders.open), sub: 'Active purchase orders', cls: 'amber' },
        ];
    }
  }

  function ensureMount() {
    var el = document.getElementById('accounting-kpi-mount');
    if (el) {
      placeMount(el);
      return el;
    }
    el = document.createElement('div');
    el.id = 'accounting-kpi-mount';
    el.innerHTML = '<div class="akpi-loading">Loading summary…</div>';
    placeMount(el);
    document.body.classList.add('akpi-active');
    return el;
  }

  /** Prefer under app-shell spacer so bubbles sit below the fixed header */
  function placeMount(el) {
    var spacer = document.getElementById('app-shell-spacer');
    if (spacer && spacer.parentNode) {
      if (el.parentNode !== spacer.parentNode || spacer.nextSibling !== el) {
        spacer.parentNode.insertBefore(el, spacer.nextSibling);
      }
      return;
    }
    var shell = document.getElementById('app-shell-header');
    if (shell && shell.parentNode) {
      shell.parentNode.insertBefore(el, shell.nextSibling);
      return;
    }
    if (el.parentNode) return; // already placed
    var root = document.getElementById('root');
    if (root && root.parentNode) {
      root.parentNode.insertBefore(el, root);
    } else {
      document.body.insertBefore(el, document.body.firstChild);
    }
  }

  function render(mount, items) {
    if (!items || !items.length) {
      mount.innerHTML = '';
      return;
    }
    mount.innerHTML =
      '<div class="akpi-grid">' +
      items
        .map(function (b) {
          return (
            '<div class="akpi ' +
            (b.cls || '') +
            '">' +
            '<div class="akpi-label">' +
            escapeHtml(b.label) +
            '</div>' +
            '<div class="akpi-value" title="' +
            escapeHtml(b.value) +
            '">' +
            escapeHtml(b.value) +
            '</div>' +
            (b.sub
              ? '<div class="akpi-sub" title="' + escapeHtml(b.sub) + '">' + escapeHtml(b.sub) + '</div>'
              : '') +
            '</div>'
          );
        })
        .join('') +
      '</div>';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function load() {
    // Skip double-mount on inventory/reports which already have custom KPIs
    // unless explicitly forced via data-kpi-force
    var script = document.querySelector('script[src*="kpi-common.js"]');
    var force = script && script.getAttribute('data-kpi-force') === '1';
    var page = pageKey();
    if (!force && (page === 'inventory' || page === 'reports')) {
      return;
    }

    var mount = ensureMount();
    try {
      var cid = companyId();
      var url = location.origin + '/api/reports/kpis?company_id=' + encodeURIComponent(cid);
      var res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      render(mount, bubblesFor(page, data));
    } catch (err) {
      console.warn('[KPI] load failed:', err);
      mount.innerHTML = '<div class="akpi-error">Summary unavailable: ' + escapeHtml(err.message) + '</div>';
    }
  }

  // Pages can call after pay/convert so open-invoice bubble updates without full reload
  window.refreshAccountingKpis = load;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }

  // Refresh when company changes in localStorage (other tab) or shell event
  window.addEventListener('storage', function (e) {
    if (e.key === 'selectedCompanyId') load();
  });
  window.addEventListener('accounting-company-changed', function () {
    load();
  });
  window.AccountingKPIs = { reload: load, pageKey: pageKey };
})();
