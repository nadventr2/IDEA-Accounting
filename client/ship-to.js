/**
 * Unified ship-to resolution for the accounting UI.
 * Precedence: override → sale/packing explicit → customer shipping → customer billing
 */
(function (global) {
  function firstNonEmpty() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (v != null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
  }

  function resolveShipTo(parts) {
    parts = parts || {};
    var customer = parts.customer || {};
    return firstNonEmpty(
      parts.override,
      parts.sale_shipping,
      parts.saleShippingAddress,
      parts.packing_shipping,
      parts.shipping_address,
      customer.shipping_address,
      customer.shippingAddress,
      parts.customer_shipping,
      customer.billing_address,
      customer.billingAddress,
      parts.customer_billing,
      parts.billing_address
    );
  }

  global.resolveShipTo = resolveShipTo;
})(typeof window !== 'undefined' ? window : global);
