// Explicit test-only page: mocks are scoped to the iframe, never the real console.
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await wait(25); }
  throw new Error('Browser timeout');
}
function assert(condition, message) { if (!condition) throw new Error(message); }

function bootstrap(options) {
  // Isolate preferences from the real app and make tests independent of browser locale.
  const preferences = new Map(options.preference ? [['canlab.language', options.preference]] : []);
  Object.defineProperty(window, 'localStorage', { configurable: true, get() {
    if (options.blockStorage) throw new DOMException('Denied', 'SecurityError');
    return { getItem: key => preferences.get(key), setItem: (key, value) => preferences.set(key, value) };
  } });
  Object.defineProperty(navigator, 'languages', { configurable: true, value: options.languages ?? ['en-US'] });
  if (options.delaySvg) {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (url, ...args) => {
      if (String(url).includes('canbus-communication.svg')) await new Promise(resolve => setTimeout(resolve, 150));
      return originalFetch(url, ...args);
    };
  }
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
  Object.defineProperty(navigator, 'serial', { configurable: true, value: { requestPort: async () => { if (options.cancelPort) throw new DOMException('Canceled', 'NotFoundError'); return ports[next++]; } } });
  window.testPorts = ports;
}

async function fixture(options = {}) {
  const html = await (await fetch('./index.html?v=timeline1', {cache:'no-store'})).text();
  const iframe = document.createElement('iframe');
  iframe.title = 'Simulated CAN/LAB console'; iframe.style.width = '1160px';
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
  const rx = n => `RX ID 0x123 DLC 4 Data: ${n.toString(16).padStart(2, '0')} 00 00 00  (Counter=${n})\n`;
  await check('SVG loaded; WebSerial available for both boards', async () => {
    assert(f.doc.querySelector('#communication-diagram svg'), 'SVG missing');
    f.click('[data-device="sender"] .connect'); f.click('[data-device="receiver"] .connect');
    await until(() => f.doc.querySelectorAll('.device.connected').length === 2);
  });
  await check('TX pulses CTX and USB, but not the CAN bus', async () => {
    f.ports[0].send('TX #1 -> ok\n');
    await until(() => f.active('sender-tx'));
    assert(f.active('sender-usb'), 'USB remains inactive');
    assert(!f.active('canh') && !f.active('receiver-rx'), 'TX was rendered as RX');
    await wait(450); assert(!f.active('sender-tx'), 'Flash does not end');
  });
  await check('RX confirms bus and CRX; ID and counter appear', async () => {
    f.ports[1].send(rx(1)); await until(() => f.active('receiver-rx'));
    assert(f.active('canh') && f.active('canl'), 'CAN wire missing');
    assert(f.doc.querySelector('[data-last-frame]').textContent === 'RX 0x123 · #1', 'Incorrect RX label');
    const glow = f.doc.querySelector('[data-wire="receiver-rx"] .wire-glow');
    const style = f.iframe.contentWindow.getComputedStyle(glow);
    assert(style.animationName === 'comm-flash' || style.opacity === '0.6', 'SVG activity style missing');
    await wait(450);
  });
  await check('Pausing and filtering the console does not stop the signal view', async () => {
    f.click('#pause');
    const search = f.doc.querySelector('#search'); search.value = 'no-matches'; search.dispatchEvent(new Event('input', { bubbles: true }));
    f.ports[1].send(rx(2)); await until(() => f.active('receiver-rx'));
    assert(f.doc.querySelector('#pause').getAttribute('aria-pressed') === 'true', 'Pause missing');
    assert(f.doc.querySelector('[data-last-frame]').textContent.endsWith('#2'), 'Signal view paused too');
    await wait(450);
    f.click('#pause'); await until(() => f.doc.querySelector('#console').textContent.includes('No lines'));
    search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await check('Rapid event sequences stay bounded and settle', async () => {
    f.ports[1].send(Array.from({ length: 100 }, () => rx(3)).join(''));
    await until(() => f.active('canh'));
    assert(f.doc.querySelectorAll('.pulse-active').length === 4, 'Unexpected wires active');
    await wait(500); assert(f.doc.querySelectorAll('.pulse-active').length === 0, 'Animations are queueing up');
  });
  await check('Bus-Off shows an error, but no reception', async () => {
    f.ports[0].send('Bus-Off -> Recovery\n');
    await until(() => f.doc.querySelector('[data-node="sender"]').classList.contains('has-error'));
    assert(!f.active('canh') && !f.active('sender-tx'), 'Error activates success path');
    await wait(450);
  });
  await check('Disconnecting clears active board highlights', async () => {
    f.ports[1].send(rx(4)); await until(() => f.active('receiver-rx'));
    f.click('[data-device="receiver"] .disconnect');
    await until(() => !f.doc.querySelector('[data-device="receiver"]').classList.contains('connected'));
    assert(!f.active('receiver-rx') && !f.active('canh'), 'Highlight remains after disconnecting');
  });
  await check('390px: SVG scrolls within its container without page overflow', async () => {
    f.iframe.style.width = '390px'; await wait(50);
    const host = f.doc.querySelector('#communication-diagram');
    assert(host.scrollWidth > host.clientWidth, 'Diagram is not scrollable');
    assert(f.doc.documentElement.scrollWidth <= f.doc.documentElement.clientWidth + 1, 'Page overflows horizontally');
    f.iframe.style.width = '1160px';
  });
  await check('Reduced motion: fixed color highlight without animation (test override)', async () => {
    const rules = Array.from(f.doc.querySelector('#communication-diagram style').sheet.cssRules);
    const reduced = rules.find(rule => rule.conditionText?.replace(/\s/g, '').includes('prefers-reduced-motion:reduce'));
    assert(reduced && reduced.cssRules[0].style.animationName === 'none', 'Reduced-motion rule missing');
    // Apply the exact bundled media-rule body in this isolated test iframe,
    // independent of the user's OS preference; no system settings are changed.
    const override = f.doc.createElementNS('http://www.w3.org/2000/svg', 'style');
    override.textContent = [...reduced.cssRules].map(rule => rule.cssText).join('\n');
    f.doc.querySelector('#communication-diagram svg').append(override);
    f.ports[0].send('TX #5 -> ok\n'); await until(() => f.active('sender-tx'));
    const glow = f.doc.querySelector('[data-wire="sender-tx"] .wire-glow');
    const computed = f.iframe.contentWindow.getComputedStyle(glow);
    assert(computed.animationName === 'none' && computed.opacity === '0.6', 'Static highlight missing');
    await wait(450); assert(!f.active('sender-tx'), 'Reduced-motion highlight remains stuck');
    override.remove();
  });
  await check('SVG 404: USB and reception still work', async () => {
    const missing = await fixture({ missingSvg: true });
    assert(missing.doc.querySelector('.diagram-unavailable'), 'Fallback missing');
    missing.click('[data-device="receiver"] .connect');
    await until(() => missing.doc.querySelector('.device.connected'));
    missing.ports[0].send(rx(9));
    await until(() => missing.doc.querySelector('#rx-count').textContent === '1');
    missing.click('[data-device="receiver"] .disconnect');
  });
  const load = await fixture({ loadTest: true });
  const senderStats = id => `LAB STATS role=sender test=${id} running=1 target=1000 queued=100 queued_fps=100 rejected=10 skipped=0 cancelled=0 pending=10 failed=0 errors=0 tec=0 rec=0 state=1 elapsed_ms=1000\n`;
  const receiverStats = (id, count) => `LAB STATS role=receiver test=${id} rx=${count} rx_fps=${count} counter=${count - 1} gaps=0 duplicates=0 missed=0 overrun=0 errors=0 tec=0 rec=0 state=1 elapsed_ms=1000\n`;
  await check('Load test starts only after firmware handshake and ARM acknowledgement', async () => {
    assert(load.doc.querySelector('#load-start').disabled, 'Start possible without USB');
    load.click('[data-device="sender"] .connect'); load.click('[data-device="receiver"] .connect');
    await until(() => !load.doc.querySelector('#load-start').disabled);
    load.click('[data-load-rate="1000"]'); load.click('#load-start');
    await until(() => load.doc.querySelector('#load-test').classList.contains('is-running'));
    const commands = load.iframe.contentWindow.testCommands.map(x => x.command);
    assert(commands.findIndex(c => c.startsWith('LAB ARM')) < commands.findIndex(c => c.startsWith('LAB START')), 'Sender started before receiver');
  });
  await check('Load test: TX statistics do not invent reception', async () => {
    load.ports[0].send(senderStats(load.ports[0].test));
    await until(() => load.doc.querySelector('#load-queued').textContent === '100');
    assert(load.doc.querySelector('#load-actual').textContent === '—', 'Reception inferred from TX');
    assert(!load.active('canh'), 'TX activates CAN reception');
  });
  await check('Load test: RX totals update metrics exactly once even with pause and filtering', async () => {
    load.click('#pause');
    const search = load.doc.querySelector('#search'); search.value = 'no-matches'; search.dispatchEvent(new Event('input', { bubbles: true }));
    const line = receiverStats(load.ports[0].test, 90);
    load.ports[1].send(line); load.ports[1].send(line);
    await until(() => load.doc.querySelector('#load-actual').textContent === '90');
    await until(() => load.doc.querySelector('#rx-count').textContent === '90');
    assert(load.doc.querySelector('#rx-count').textContent === '90', `Duplicate summation: ${load.doc.querySelector('#rx-count').textContent}`);
    assert(load.doc.querySelector('#load-rejected').textContent === '10', 'Queue rejections missing');
    assert(load.doc.querySelector('#load-gaps').textContent === '0', 'Queue rejections counted as RX loss');
  });
  await check('Time chart shows separate TX/RX points even with a paused console', async () => {
    assert(load.doc.querySelector('#load-tx-line').getAttribute('d').startsWith('M'), 'TX curve missing');
    assert(load.doc.querySelector('#load-rx-line').getAttribute('d').startsWith('M'), 'RX curve missing');
    assert(load.doc.querySelectorAll('#load-chart-points circle').length === 2, 'Duplicate or missing points');
    assert(load.doc.querySelector('[data-chart-second="60"]').textContent === '60 s', 'Seconds axis missing');
  });
  await check('Language changes during a running test preserve ports, measurements, inputs and paused logs', async () => {
    const select = load.doc.querySelector('[data-language]');
    const commands = JSON.stringify(load.iframe.contentWindow.testCommands);
    const frozenLines = load.doc.querySelectorAll('.log-line').length;
    const chartPath = load.doc.querySelector('#load-rx-line').getAttribute('d');
    const switchTo = value => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); };
    switchTo('de');
    assert(load.doc.documentElement.lang === 'de', 'German language missing');
    assert(load.doc.querySelector('#load-start').textContent === 'Test starten ↗', 'Static button not translated');
    assert(load.doc.querySelector('#load-status').textContent.startsWith('Lasttest läuft.'), 'Status not translated');
    assert(load.doc.querySelector('#load-target').textContent === '1.000', 'Numbers not localized');
    assert(load.doc.querySelector('#pause').textContent === 'Anzeige fortsetzen', 'Paused label not translated');
    assert(load.doc.querySelector('[data-node-status="receiver"]').textContent === 'RX erkannt', 'SVG status not translated');
    assert(load.doc.querySelector('svg title').textContent.includes('CAN-Kommunikation'), 'SVG accessible title not translated');
    assert(load.doc.querySelector('#load-chart-points title').textContent.includes('1,00 s'), 'Existing tooltip not translated');
    assert(load.doc.querySelector('#load-test').classList.contains('is-running'), 'Test was stopped');
    assert(load.doc.querySelectorAll('.device.connected').length === 2, 'USB lost');
    assert(load.doc.querySelector('#load-rate').value === '1000', 'Input reset');
    assert(load.doc.querySelector('#search').value === 'no-matches', 'Filter reset');
    assert(load.doc.querySelector('#load-actual').textContent === '90', 'Measurements lost');
    assert(load.doc.querySelector('#load-rx-line').getAttribute('d') === chartPath, 'Chart reset');
    assert(load.doc.querySelectorAll('.log-line').length === frozenLines, 'Paused display advanced');
    assert(JSON.stringify(load.iframe.contentWindow.testCommands) === commands, 'Language change issued commands');
    load.iframe.style.width = '390px'; await wait(50);
    assert(load.doc.documentElement.scrollWidth <= load.doc.documentElement.clientWidth + 1, 'German page overflows');
    assert(select.getBoundingClientRect().width > 0, 'Mobile language control hidden');
    load.iframe.style.width = '1160px';
    switchTo('en');
    assert(load.doc.querySelector('#load-target').textContent === '1,000', 'English numbers missing');
    switchTo('auto');
    assert(load.doc.documentElement.lang === 'en', 'Automatic choice not restored');
  });
  await check('Slider moves in steps of five; preset 1 remains available', async () => {
    const slider=load.doc.querySelector('#load-slider');
    assert(slider.min === '5' && slider.step === '5', 'Slider not set to multiples of five');
    slider.value='105'; slider.dispatchEvent(new Event('input', {bubbles:true}));
    assert(load.doc.querySelector('#load-rate').value === '105', 'Slider not synchronized');
    load.click('[data-load-rate="1"]');
    assert(load.doc.querySelector('#load-rate').value === '1', 'One frame/s is no longer possible');
  });
  await check('Load test: new rate is acknowledged and stop remains available', async () => {
    load.click('[data-load-rate="5000"]'); load.click('#load-rate-apply');
    await until(() => load.doc.querySelector('#load-target').textContent === '5,000');
    load.click('#load-stop');
    await until(() => !load.doc.querySelector('#load-test').classList.contains('is-running'));
    assert(load.doc.querySelector('#load-rate-apply').disabled, 'Rate change possible after stop');
    assert(load.doc.querySelector('#load-actual').textContent === '90', 'Final values disappeared');
  });
  await check('Load test: no horizontal page overflow at 390px', async () => {
    load.iframe.style.width = '390px'; await wait(50);
    assert(load.doc.documentElement.scrollWidth <= load.doc.documentElement.clientWidth + 1, 'Load test overflows');
    load.iframe.style.width = '1160px';
  });
  await check('Load test: disconnecting receiver requests sender stop', async () => {
    load.click('#load-start'); await until(() => load.doc.querySelector('#load-test').classList.contains('is-running'));
    load.click('[data-device="receiver"] .disconnect');
    await until(() => !load.doc.querySelector('[data-device="receiver"]').classList.contains('connected'));
    assert(load.doc.querySelector('#load-start').disabled, 'Start possible after disconnecting');
    assert(load.iframe.contentWindow.testCommands.at(-1).command === 'LAB STOP', 'No stop on disconnect');
  });
  await check('German automatic selection, delayed SVG and blocked storage work together', async () => {
    const localized = await fixture({ languages: ['fr-FR', 'de-AT'], blockStorage: true, delaySvg: true, cancelPort: true });
    assert(localized.doc.documentElement.lang === 'de', 'Preferred supported language not selected');
    assert(localized.doc.title.includes('Lasttests'), 'Document title missing');
    assert(localized.doc.querySelector('[data-node-status="receiver"]').textContent === 'Nicht verbunden', 'Delayed SVG not translated');
    localized.click('[data-device="sender"] .connect');
    await until(() => localized.doc.querySelector('#console').textContent.includes('Portauswahl abgebrochen.'));
    const select = localized.doc.querySelector('[data-language]');
    select.value = 'en'; select.dispatchEvent(new Event('change', { bubbles: true }));
    assert(localized.doc.documentElement.lang === 'en', 'Blocked storage prevented selection');
    assert(localized.doc.querySelector('#console').textContent.includes('Port selection canceled.'), 'Existing error not retranslated');
    select.value = 'auto'; select.dispatchEvent(new Event('change', { bubbles: true }));
    assert(localized.doc.documentElement.lang === 'de', 'Automatic selection did not return');
  });
  await check('Saved manual preference overrides browser language', async () => {
    const saved = await fixture({ languages: ['de-DE'], preference: 'en', missingSvg: true });
    assert(saved.doc.documentElement.lang === 'en', 'Saved preference ignored');
    const select = saved.doc.querySelector('[data-language]');
    select.value = 'de'; select.dispatchEvent(new Event('change', { bubbles: true }));
    assert(saved.doc.querySelector('.diagram-unavailable').textContent.startsWith('Signaldiagramm konnte'), 'Diagram failure not translated');
  });
  await check('German UI preserves firmware text and exports original logs', async () => {
    const raw = await fixture({ languages: ['de-DE'] });
    raw.click('[data-device="sender"] .connect');
    await until(() => raw.doc.querySelector('.device.connected'));
    raw.ports[0].send('Receiver\nRX ID 0x123 DLC 4 Data: 01 00 00 00  (Counter=1)\n');
    await until(() => [...raw.doc.querySelectorAll('.log-message')].some(node => node.textContent === 'Receiver'));
    assert(raw.doc.querySelector('#console').textContent.includes('RX ID 0x123 DLC 4 Data: 01 00 00 00  (Counter=1)'), 'Firmware log changed');
    const win = raw.iframe.contentWindow, original = win.URL.createObjectURL.bind(win.URL);
    let exported;
    win.URL.createObjectURL = blob => { exported = blob; return original(blob); };
    raw.doc.addEventListener('click', event => { if (event.target.closest('a[download]')) event.preventDefault(); }, true);
    raw.click('#export');
    const data = await exported.text();
    assert(data.includes('[sender] Receiver\n'), 'Raw device text translated in export');
    assert(data.includes('[system] Ready. Sender and receiver can be connected simultaneously.'), 'Original application log changed in export');
    assert(!data.includes('Bereit. Sender und Empfänger'), 'Localized UI text leaked into export');
  });
  // Leave a clean simulated view for visual inspection, never the real USB page.
  await fixture();
  document.querySelector('#result').textContent = `${passed} passed · ${failed} failed · Simulation, not a hardware test`;
  runButton.disabled = false;
}
document.querySelector('#run').addEventListener('click', () => {
  run().catch(error => { document.querySelector('#result').textContent = `Test aborted: ${error.message}`; document.querySelector('#run').disabled = false; });
});
