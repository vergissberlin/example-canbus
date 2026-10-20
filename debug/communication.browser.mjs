// Explicit test-only page: mocks are scoped to the iframe, never the real console.
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await wait(25); }
  throw new Error('Browser-Timeout');
}
function assert(condition, message) { if (!condition) throw new Error(message); }

function bootstrap(options) {
  if (options.missingSvg) {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (url, ...args) => String(url).includes('canbus-communication.svg')
      ? Promise.resolve(new Response('', { status: 404 })) : originalFetch(url, ...args);
  }
  function port() {
    return {
      readable: null, controller: null,
      async open() { this.readable = new ReadableStream({ start: controller => { this.controller = controller; } }); },
      async close() { this.readable = null; }, async setSignals() {},
      getInfo() { return { usbVendorId: 0x303a, usbProductId: 0x1001 }; },
      send(line) { this.controller.enqueue(new TextEncoder().encode(line)); }
    };
  }
  const ports = [port(), port()]; let next = 0;
  Object.defineProperty(navigator, 'serial', { configurable: true, value: { requestPort: async () => ports[next++] } });
  window.testPorts = ports;
}

async function fixture(options = {}) {
  const html = await (await fetch('./index.html')).text();
  const iframe = document.createElement('iframe');
  iframe.title = 'Simulierte CAN/LAB-Konsole'; iframe.style.width = '1160px';
  const base = new URL('./', location.href).href;
  iframe.srcdoc = html.replace('<head>', `<head><base href="${base}"><script>(${bootstrap.toString()})(${JSON.stringify(options)})</script>`);
  document.querySelector('#fixtures').replaceChildren(iframe);
  await until(() => iframe.contentDocument?.querySelector('#communication-diagram') && iframe.contentWindow.testPorts);
  const doc = iframe.contentDocument;
  await until(() => doc.querySelector('#communication-diagram svg, .diagram-unavailable'));
  return { iframe, doc, ports: iframe.contentWindow.testPorts,
    active: wire => doc.querySelector(`[data-wire="${wire}"]`)?.classList.contains('pulse-active'),
    click: selector => doc.querySelector(selector).click()
  };
}

async function run() {
  const runButton = document.querySelector('#run'); runButton.disabled = true;
  document.querySelector('#results').replaceChildren(); let passed = 0, failed = 0;
  async function check(name, fn) {
    const item = document.createElement('li');
    try { await fn(); item.className = 'pass'; item.textContent = `PASS · ${name}`; passed++; }
    catch (error) { item.className = 'fail'; item.textContent = `FAIL · ${name}: ${error.message}`; failed++; }
    document.querySelector('#results').append(item);
  }
  const f = await fixture();
  const rx = n => `RX ID 0x123 DLC 4 Daten: ${n.toString(16).padStart(2, '0')} 00 00 00  (Zaehler=${n})\n`;
  await check('SVG geladen; WebSerial für beide Boards verfügbar', async () => {
    assert(f.doc.querySelector('#communication-diagram svg'), 'SVG fehlt');
    f.click('[data-device="sender"] .connect'); f.click('[data-device="receiver"] .connect');
    await until(() => f.doc.querySelectorAll('.device.connected').length === 2);
  });
  await check('TX pulsiert CTX und USB, aber nicht den CAN-Bus', async () => {
    f.ports[0].send('TX #1 -> ok\n');
    await until(() => f.active('sender-tx'));
    assert(f.active('sender-usb'), 'USB bleibt inaktiv');
    assert(!f.active('canh') && !f.active('receiver-rx'), 'TX wurde als RX dargestellt');
    await wait(450); assert(!f.active('sender-tx'), 'Blitz endet nicht');
  });
  await check('RX bestätigt Bus und CRX; ID und Zähler erscheinen', async () => {
    f.ports[1].send(rx(1)); await until(() => f.active('receiver-rx'));
    assert(f.active('canh') && f.active('canl'), 'CAN-Leitung fehlt');
    assert(f.doc.querySelector('[data-last-frame]').textContent === 'RX 0x123 · #1', 'Falsche RX-Beschriftung');
    const glow = f.doc.querySelector('[data-wire="receiver-rx"] .wire-glow');
    const style = f.iframe.contentWindow.getComputedStyle(glow);
    assert(style.animationName === 'comm-flash' || style.opacity === '0.6', 'SVG-Aktivitätsstil fehlt');
    await wait(450);
  });
  await check('Pausierte und gefilterte Konsole stoppt die Signalansicht nicht', async () => {
    f.click('#pause');
    const search = f.doc.querySelector('#search'); search.value = 'keine-treffer'; search.dispatchEvent(new Event('input', { bubbles: true }));
    f.ports[1].send(rx(2)); await until(() => f.active('receiver-rx'));
    assert(f.doc.querySelector('#pause').getAttribute('aria-pressed') === 'true', 'Pause fehlt');
    assert(f.doc.querySelector('[data-last-frame]').textContent.endsWith('#2'), 'Signalansicht pausiert mit');
    await wait(450);
    f.click('#pause'); await until(() => f.doc.querySelector('#console').textContent.includes('Keine Zeilen'));
    search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await check('Schnelle Ereignisfolgen bleiben begrenzt und kommen zur Ruhe', async () => {
    f.ports[1].send(Array.from({ length: 100 }, () => rx(3)).join(''));
    await until(() => f.active('canh'));
    assert(f.doc.querySelectorAll('.pulse-active').length === 4, 'Unerwartete Leitungen aktiv');
    await wait(500); assert(f.doc.querySelectorAll('.pulse-active').length === 0, 'Animationen stauen sich');
  });
  await check('Bus-Off zeigt Fehler, aber keinen Empfang', async () => {
    f.ports[0].send('Bus-Off -> Recovery\n');
    await until(() => f.doc.querySelector('[data-node="sender"]').classList.contains('has-error'));
    assert(!f.active('canh') && !f.active('sender-tx'), 'Fehler aktiviert Erfolgspfad');
    await wait(450);
  });
  await check('Trennen entfernt aktive Markierungen des Boards', async () => {
    f.ports[1].send(rx(4)); await until(() => f.active('receiver-rx'));
    f.click('[data-device="receiver"] .disconnect');
    await until(() => !f.doc.querySelector('[data-device="receiver"]').classList.contains('connected'));
    assert(!f.active('receiver-rx') && !f.active('canh'), 'Markierung bleibt nach Trennen');
  });
  await check('390px: SVG scrollt im Container, Seite läuft nicht über', async () => {
    f.iframe.style.width = '390px'; await wait(50);
    const host = f.doc.querySelector('#communication-diagram');
    assert(host.scrollWidth > host.clientWidth, 'Grafik nicht scrollbar');
    assert(f.doc.documentElement.scrollWidth <= f.doc.documentElement.clientWidth + 1, 'Seite läuft horizontal über');
    f.iframe.style.width = '1160px';
  });
  await check('Reduced Motion: feste Farbmarkierung ohne Animation (Test-Override)', async () => {
    const rules = Array.from(f.doc.querySelector('#communication-diagram style').sheet.cssRules);
    const reduced = rules.find(rule => rule.conditionText?.replace(/\s/g, '').includes('prefers-reduced-motion:reduce'));
    assert(reduced && reduced.cssRules[0].style.animationName === 'none', 'Reduced-Motion-Regel fehlt');
    // Apply the exact bundled media-rule body in this isolated test iframe,
    // independent of the user's OS preference; no system settings are changed.
    const override = f.doc.createElementNS('http://www.w3.org/2000/svg', 'style');
    override.textContent = [...reduced.cssRules].map(rule => rule.cssText).join('\n');
    f.doc.querySelector('#communication-diagram svg').append(override);
    f.ports[0].send('TX #5 -> ok\n'); await until(() => f.active('sender-tx'));
    const glow = f.doc.querySelector('[data-wire="sender-tx"] .wire-glow');
    const computed = f.iframe.contentWindow.getComputedStyle(glow);
    assert(computed.animationName === 'none' && computed.opacity === '0.6', 'Statische Markierung fehlt');
    await wait(450); assert(!f.active('sender-tx'), 'Reduced-Motion-Markierung bleibt hängen');
    override.remove();
  });
  await check('404 für SVG: USB und Empfang funktionieren trotzdem', async () => {
    const missing = await fixture({ missingSvg: true });
    assert(missing.doc.querySelector('.diagram-unavailable'), 'Fallback fehlt');
    missing.click('[data-device="receiver"] .connect');
    await until(() => missing.doc.querySelector('.device.connected'));
    missing.ports[0].send(rx(9));
    await until(() => missing.doc.querySelector('#rx-count').textContent === '1');
    missing.click('[data-device="receiver"] .disconnect');
  });
  // Leave a clean simulated view for visual inspection, never the real USB page.
  await fixture();
  document.querySelector('#result').textContent = `${passed} bestanden · ${failed} fehlgeschlagen · Simulation, kein Hardwaretest`;
  runButton.disabled = false;
}
document.querySelector('#run').addEventListener('click', () => {
  run().catch(error => { document.querySelector('#result').textContent = `Testabbruch: ${error.message}`; document.querySelector('#run').disabled = false; });
});
