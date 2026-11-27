// Google Tag Manager, one container per site section (picked by hostname).
// www/root + landing sub-pages: P8FQVQ3K · app.: 5VXGLD5P · merchant.: NXTPB72Z. admin/sandbox/demo/localhost: no tracking.
(() => {
  const h = location.hostname;
  const id = h === 'app.placemyorder.online' ? 'GTM-5VXGLD5P'
    : h === 'merchant.placemyorder.online' ? 'GTM-NXTPB72Z'
    : h === 'placemyorder.online' || h === 'www.placemyorder.online' ? 'GTM-P8FQVQ3K' : null;
  if (!id) return;
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
  const s = document.createElement('script');
  s.async = true; s.src = 'https://www.googletagmanager.com/gtm.js?id=' + id;
  document.head.appendChild(s);
})();
