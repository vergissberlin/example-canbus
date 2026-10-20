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
  window.testCommands = [];
  function port(role) {
    return {
      readable: null, controller: null, test: 0,
      async open() {
        this.readable = new ReadableStream({ start: controller => { this.controller = controller; } });
        if (options.loadTest) this.writable = new WritableStream({ write: value => {
          const command = new TextDecoder().decode(value).trim();
          window.testCommands.push({ role, command });
          const parts = command.split(' '), operation = parts[1].toLowerCase();
          if (operation === 'hello') this.send(`LAB HELLO role=${role} version=1 bitrate=500000 max_rate=20000 max_seconds=60\n`);
          else {
            if (['arm', 'start'].includes(operation)) this.test = Number(parts[2]);
            this.send(`LAB ACK role=${role} command=${operation} test=${this.test}\n`);
          }
        } });
      },
      async close() { this.readable = this.writable = null; }, async setSignals() {},
      getInfo() { return { usbVendorId: 0x303a, usbProductId: 0x1001 }; },
      send(line) { this.controller.enqueue(new TextEncoder().encode(line)); }
    };
  }
  const ports = [port('sender'), port('receiver')]; let next = 0;
  Object.defineProperty(navigator, 'serial', { configurable: true, value: { requestPort: async () => ports[next++] } });
  window.testPorts = ports;
}

async function fixture(options = {}) {
  const html = await (await fetch('./index.html?v=timeline1', {cache:'no-store'})).text();
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
  const load = await fixture({ loadTest: true });
  const senderStats = id => `LAB STATS role=sender test=${id} running=1 target=1000 queued=100 queued_fps=100 rejected=10 skipped=0 cancelled=0 pending=10 failed=0 errors=0 tec=0 rec=0 state=1 elapsed_ms=1000\n`;
  const receiverStats = (id, count) => `LAB STATS role=receiver test=${id} rx=${count} rx_fps=${count} counter=${count - 1} gaps=0 duplicates=0 missed=0 overrun=0 errors=0 tec=0 rec=0 state=1 elapsed_ms=1000\n`;
  await check('Lasttest startet erst nach Firmware-Handshake und ARM-Bestätigung', async () => {
    assert(load.doc.querySelector('#load-start').disabled, 'Start ohne USB möglich');
    load.click('[data-device="sender"] .connect'); load.click('[data-device="receiver"] .connect');
    await until(() => !load.doc.querySelector('#load-start').disabled);
    load.click('[data-load-rate="1000"]'); load.click('#load-start');
    await until(() => load.doc.querySelector('#load-test').classList.contains('is-running'));
    const commands = load.iframe.contentWindow.testCommands.map(x => x.command);
    assert(commands.findIndex(c => c.startsWith('LAB ARM')) < commands.findIndex(c => c.startsWith('LAB START')), 'Sender vor Receiver gestartet');
  });
  await check('Lasttest: TX-Statistik erzeugt keinen erfundenen Empfang', async () => {
    load.ports[0].send(senderStats(load.ports[0].test));
    await until(() => load.doc.querySelector('#load-queued').textContent === '100');
    assert(load.doc.querySelector('#load-actual').textContent === '—', 'Empfang aus TX abgeleitet');
    assert(!load.active('canh'), 'TX aktiviert CAN-Empfang');
  });
  await check('Lasttest: RX-Summen aktualisieren Metriken auch bei Pause und Filter genau einmal', async () => {
    load.click('#pause');
    const search = load.doc.querySelector('#search'); search.value = 'keine-treffer'; search.dispatchEvent(new Event('input', { bubbles: true }));
    const line = receiverStats(load.ports[0].test, 90);
    load.ports[1].send(line); load.ports[1].send(line);
    await until(() => load.doc.querySelector('#load-actual').textContent === '90');
    await until(() => load.doc.querySelector('#rx-count').textContent === '90');
    assert(load.doc.querySelector('#rx-count').textContent === '90', `Doppelte Summierung: ${load.doc.querySelector('#rx-count').textContent}`);
    assert(load.doc.querySelector('#load-rejected').textContent === '10', 'Queue-Rückweisungen fehlen');
    assert(load.doc.querySelector('#load-gaps').textContent === '0', 'Queue-Rückweisungen als RX-Verlust gezählt');
  });
  await check('Zeitdiagramm zeigt getrennte TX/RX-Punkte trotz pausierter Konsole', async () => {
    assert(load.doc.querySelector('#load-tx-line').getAttribute('d').startsWith('M'), 'TX-Kurve fehlt');
    assert(load.doc.querySelector('#load-rx-line').getAttribute('d').startsWith('M'), 'RX-Kurve fehlt');
    assert(load.doc.querySelectorAll('#load-chart-points circle').length === 2, 'Doppelte oder fehlende Punkte');
    assert(load.doc.querySelector('[data-chart-second="60"]').textContent === '60 s', 'Sekundenachse fehlt');
  });
  await check('Regler bewegt sich in Fünferschritten, Vorgabe 1 bleibt verfügbar', async () => {
    const slider=load.doc.querySelector('#load-slider');
    assert(slider.min === '5' && slider.step === '5', 'Regler nicht auf Vielfache von fünf gesetzt');
    slider.value='105'; slider.dispatchEvent(new Event('input', {bubbles:true}));
    assert(load.doc.querySelector('#load-rate').value === '105', 'Regler nicht synchronisiert');
    load.click('[data-load-rate="1"]');
    assert(load.doc.querySelector('#load-rate').value === '1', 'Ein Frame/s nicht mehr möglich');
  });
  await check('Lasttest: neue Rate wird bestätigt, Stopp bleibt bedienbar', async () => {
    load.click('[data-load-rate="5000"]'); load.click('#load-rate-apply');
    await until(() => load.doc.querySelector('#load-target').textContent === '5.000');
    load.click('#load-stop');
    await until(() => !load.doc.querySelector('#load-test').classList.contains('is-running'));
    assert(load.doc.querySelector('#load-rate-apply').disabled, 'Ratenänderung nach Stopp möglich');
    assert(load.doc.querySelector('#load-actual').textContent === '90', 'Endwerte verschwunden');
  });
  await check('Lasttest: 390px bleibt ohne horizontales Seiten-Overflow', async () => {
    load.iframe.style.width = '390px'; await wait(50);
    assert(load.doc.documentElement.scrollWidth <= load.doc.documentElement.clientWidth + 1, 'Lasttest läuft über');
    load.iframe.style.width = '1160px';
  });
  await check('Lasttest: Receiver-Trennen fordert Sender-Stopp an', async () => {
    load.click('#load-start'); await until(() => load.doc.querySelector('#load-test').classList.contains('is-running'));
    load.click('[data-device="receiver"] .disconnect');
    await until(() => !load.doc.querySelector('[data-device="receiver"]').classList.contains('connected'));
    assert(load.doc.querySelector('#load-start').disabled, 'Start nach Trennen möglich');
    assert(load.iframe.contentWindow.testCommands.at(-1).command === 'LAB STOP', 'Kein Stopp beim Trennen');
  });
  // Leave a clean simulated view for visual inspection, never the real USB page.
  await fixture();
  document.querySelector('#result').textContent = `${passed} bestanden · ${failed} fehlgeschlagen · Simulation, kein Hardwaretest`;
  runButton.disabled = false;
}
document.querySelector('#run').addEventListener('click', () => {
  run().catch(error => { document.querySelector('#result').textContent = `Testabbruch: ${error.message}`; document.querySelector('#run').disabled = false; });
});
