// Shows a banner on sandbox deployments only (the API reports sandbox:true when SANDBOX is set).
fetch('/api/config').then((r) => r.json()).then((c) => {
  if (!c.sandbox) return;
  const b = document.createElement('div');
  b.textContent = 'SANDBOX · test data only · not the live service';
  b.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#8F5200;color:#fff;font:700 11px/1 ui-monospace,monospace;letter-spacing:.12em;text-align:center;padding:6px;pointer-events:none';
  document.body.append(b);
}).catch(() => {});
