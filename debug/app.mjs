import { parseLine, counterGap, LineBuffer } from './protocol.mjs';
import { CommunicationView, loadCommunication } from './communication.mjs?v=builtin-termination';
import { LoadTest, parseLabLine, timeline, CHART_SERIES } from './load-test.mjs?v=diagnostics1';

const $ = selector => document.querySelector(selector);
const MAX_LINES = 2000;
const devices = new Map();
const communication = new CommunicationView();
const loadTest = new LoadTest({ send: writeCommand, changed: renderLoad });
// Loading the optional drawing must never block USB initialization.
void loadCommunication(document.querySelector('#communication-diagram'), communication);
let logs = [], paused = false, dirty = true;
let rxCount = 0, gapCount = 0, latestCounter = null, lastRx = 0;
const supported = 'serial' in navigator && window.isSecureContext;

function log(source, message, kind = null) {
  if (!message.trim()) return;
  const parsed = parseLine(message);
  const lab = parseLabLine(message);
  logs.push({ time: new Date(), source, message, kind: kind || parsed.kind });
  if (logs.length > MAX_LINES) logs.splice(0, logs.length - MAX_LINES);
  const device = devices.get(source);
  if (device && lab && loadTest.accept(source, lab)) loadActivity(device, lab);
  if (device) communication.event(source, kind ? { kind } : parsed);
  if (device && parsed.kind === 'rx') {
    device.lastRx = Date.now();
    lastRx = device.lastRx;
    if (parsed.counter !== null) {
      rxCount++;
      gapCount += counterGap(device.previousCounter, parsed.counter);
      device.previousCounter = parsed.counter;
      latestCounter = parsed.counter;
    }
  }
  dirty = true;
}

function updateDevice(device, state) {
  if (state === 'connected') { communication.connection(device.name, true); loadTest.connection(device.name, true); }
  else if (state === 'idle' || state === 'closing') { communication.connection(device.name, false); loadTest.connection(device.name, false); }
  device.card.classList.toggle('connected', state === 'connected');
  device.card.querySelector('.device-state').textContent = {
    idle: 'Not connected', connecting: 'Select port / connecting …',
    connected: 'USB connected', closing: 'Disconnecting …'
  }[state];
  device.card.querySelector('.connect').disabled = !supported || state !== 'idle';
  device.card.querySelector('.disconnect').disabled = state !== 'connected';
}

function explainError(error) {
  if (error.name === 'NotFoundError') return 'Port selection canceled.';
  if (error.name === 'SecurityError') return 'USB access blocked. Open this page in Edge or Chrome on localhost.';
  if (error.name === 'NetworkError' || error.name === 'InvalidStateError') return 'Port unavailable. Close other serial monitors and check the USB connection. ' + error.message;
  return error.message || String(error);
}

async function connect(device) {
  updateDevice(device, 'connecting');
  let port;
  try {
    port = await navigator.serial.requestPort();
    if ([...devices.values()].some(other => other !== device && other.port === port)) {
      throw new Error('This port is already connected to the other board. Select the second ESP.');
    }
    await port.open({ baudRate: 115200 });
    device.port = port;
    device.previousCounter = null;
    device.labTotals = null;
    device.lastRx = 0;
    device.stopping = false;
    const info = port.getInfo();
    device.card.querySelector('.device-info').textContent = `USB ${info.usbVendorId?.toString(16).padStart(4, '0') || '????'}:${info.usbProductId?.toString(16).padStart(4, '0') || '????'} · 115200 Baud`;
    try { await port.setSignals({ dataTerminalReady: true }); }
    catch { log(device.name, 'Could not set DTR. If there is no output, briefly press RESET.', 'system'); }
    updateDevice(device, 'connected');
    log(device.name, 'USB connected. Waiting for serial output …', 'system');
    device.task = read(device);
    void loadTest.identify(device.name);
  } catch (error) {
    if (device.port) { try { await device.port.close(); } catch {} device.port = null; }
    updateDevice(device, 'idle');
    log(device.name, explainError(error), 'error');
  }
}

async function read(device) {
  const decoder = new TextDecoder();
  const lines = new LineBuffer();
  try {
    while (device.port?.readable && !device.stopping) {
      const reader = device.port.readable.getReader();
      device.reader = reader;
      try {
        while (!device.stopping) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value?.byteLength) communication.event(device.name, { kind: 'usb' });
          for (const line of lines.push(decoder.decode(value, { stream: true }))) log(device.name, line);
        }
      } catch (error) {
        if (!device.stopping) {
          log(device.name, explainError(error), 'error');
          // Recoverable serial framing errors may leave a readable stream.
          if (!device.port?.readable) break;
          await new Promise(resolve => setTimeout(resolve, 150));
        }
      } finally { reader.releaseLock(); device.reader = null; }
    }
  } catch (error) {
    if (!device.stopping) log(device.name, explainError(error), 'error');
  } finally {
    for (const line of lines.push(decoder.decode())) log(device.name, line);
    const tail = lines.flush();
    if (tail) log(device.name, tail);
    try { await device.writes; } catch {}
    try { await device.port?.close(); } catch {}
    device.port = null;
    device.stopping = false;
    updateDevice(device, 'idle');
    device.card.querySelector('.device-info').textContent = 'Select a USB port in the browser · 115200 baud';
    log(device.name, 'USB connection closed.', 'system');
  }
}

async function disconnect(device) {
  if (!device.port || device.stopping) return;
  if (loadTest.active) { try { await loadTest.stop(); } catch {} }
  device.stopping = true;
  updateDevice(device, 'closing');
  try { await device.reader?.cancel(); await device.task; }
  catch (error) { log(device.name, explainError(error), 'error'); }
}

async function writeCommand(name, command) {
  const device = devices.get(name);
  if (!device?.port?.writable || device.stopping) throw new Error('USB writing unavailable.');
  const task = (device.writes || Promise.resolve()).catch(() => {}).then(async () => {
    if (!device.port?.writable || device.stopping) throw new Error('USB connection closed.');
    const writer = device.port.writable.getWriter();
    try { await writer.write(new TextEncoder().encode(command + '\n')); }
    finally { writer.releaseLock(); }
  });
  device.writes = task;
  return task;
}

function loadActivity(device, event) {
  if (event.type === 'error') { communication.event(device.name, { kind: 'error' }); return; }
  if (event.type !== 'stats' || !event.test || event.test !== loadTest.session?.id) return;
  const previous = device.labTotals?.test === event.test ? device.labTotals : null;
  const failed = event.state === 2 || event.errors > (previous?.errors ?? 0);
  if (failed) communication.event(device.name, { kind: 'error' });
  if (event.role === 'receiver') {
    const delta = Math.max(0, event.rx - (previous?.rx ?? 0));
    rxCount += delta;
    gapCount += Math.max(0, event.gaps - (previous?.gaps ?? 0));
    if (delta) {
      latestCounter = event.counter; lastRx = device.lastRx = Date.now();
      if (!failed) communication.event(device.name, { kind: 'rx', id: 0x123, counter: event.counter });
    }
  } else if (!failed && event.queued > (previous?.queued ?? 0)) communication.event(device.name, { kind: 'queued' });
  device.labTotals = event;
}

function renderLoad() {
  const session = loadTest.session, tx = session?.tx, rx = session?.rx;
  $('#load-start').disabled = !loadTest.ready || loadTest.busy || loadTest.active;
  $('#load-rate-apply').disabled = !loadTest.active || loadTest.busy;
  $('#load-stop').disabled = !loadTest.boards.sender.connected || !loadTest.boards.sender.ready;
  $('#load-duration').disabled = loadTest.active || loadTest.busy;
  $('#load-rate').disabled = loadTest.busy;
  $('#load-slider').disabled = loadTest.busy;
  $('#load-status').textContent = loadTest.message;
  $('#load-test').classList.toggle('is-running', loadTest.active);
  $('#load-target').textContent = session ? session.rate.toLocaleString('en-US') : '—';
  $('#load-actual').textContent = rx ? rx.rx_fps.toLocaleString('en-US') : '—';
  $('#load-queued-rate').textContent = tx ? tx.queued_fps.toLocaleString('en-US') : '—';
  const value = (id, n) => { $(id).textContent = n === undefined ? '—' : n.toLocaleString('en-US'); };
  value('#load-queued', tx?.queued); value('#load-rx-total', rx?.rx); value('#load-rejected', tx?.rejected);
  value('#load-gaps', rx?.gaps); value('#load-skipped', tx?.skipped); value('#load-pending', tx?.pending);
  $('#load-errors').textContent = `${tx?.errors ?? '—'} / ${rx?.errors ?? '—'}`;
  $('#load-missed').textContent = `${rx?.missed ?? '—'} / ${rx?.overrun ?? '—'}`;
  $('#load-elapsed').textContent = tx ? `${(tx.elapsed_ms / 1000).toFixed(1)} / ${session.seconds} s` : 'No load test yet';
  $('#load-freshness').textContent = session?.updated && Date.now() - session.updated > 3000
    ? 'Status report older than three seconds; the last measured rate remains displayed.' : 'Firmware measurement windows · about one status report per second';
  const enabled = [...document.querySelectorAll('[data-chart-series]:checked')].map(input => input.value);
  const chart = timeline(session?.samples, enabled);
  for (const series of CHART_SERIES) {
    const path = document.querySelector(`[data-chart-path="${series.id}"]`);
    path.setAttribute('d', chart.paths[series.id]);
  }
  $('#load-chart-max').textContent = chart.maximum.toLocaleString('en-US');
  $('#load-diagnostic-max').textContent = chart.diagnosticMaximum.toLocaleString('en-US');
  for (const label of document.querySelectorAll('[data-chart-second]')) {
    label.textContent = `${Math.round(chart.start / 1000) + Number(label.dataset.chartSecond)} s`;
  }
  const dots = $('#load-chart-points');
  const points = [...chart.points, ...chart.diagnosticPoints];
  const signature = JSON.stringify(points);
  if (dots.dataset.samples !== signature) {
    dots.dataset.samples = signature;
    dots.replaceChildren(...points.map(point => {
      const series = CHART_SERIES.find(item => item.id === point.series);
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', point.x); dot.setAttribute('cy', point.y); dot.setAttribute('r', '3');
      dot.setAttribute('fill', series.color); dot.dataset.series = series.id;
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      const unit = series.unit ?? (series.gauge ? 'frames pending' : `events / ${((point.span ?? 1000) / 1000).toFixed(2)} s window`);
      title.textContent = `${(point.elapsed / 1000).toFixed(2)} s · ${series.label}: ${point.value.toLocaleString('en-US')} ${unit}`;
      dot.append(title); return dot;
    }));
  }
}

for (const input of document.querySelectorAll('[data-chart-series]')) input.addEventListener('change', renderLoad);

for (const id of ['load-rate', 'load-slider']) $('#' + id).addEventListener('input', event => {
  $(id === 'load-rate' ? '#load-slider' : '#load-rate').value = event.target.value;
});
for (const button of document.querySelectorAll('[data-load-rate]')) button.addEventListener('click', () => {
  $('#load-rate').value = $('#load-slider').value = button.dataset.loadRate;
});
for (const [id, action] of [
  ['load-start', () => loadTest.start($('#load-rate').value, $('#load-duration').value)],
  ['load-rate-apply', () => loadTest.rate($('#load-rate').value)],
  ['load-stop', () => loadTest.stop()]
]) $('#' + id).addEventListener('click', () => {
  void action().catch(error => { loadTest.message = error.message; renderLoad(); log('system', error.message, 'error'); });
});

for (const name of ['sender', 'receiver']) {
  const card = $(`[data-device=${name}]`);
  const device = { name, card, port: null, reader: null, stopping: false, previousCounter: null, lastRx: 0 };
  devices.set(name, device);
  card.querySelector('.connect').addEventListener('click', () => connect(device));
  card.querySelector('.disconnect').addEventListener('click', () => disconnect(device));
  updateDevice(device, 'idle');
}

if (!supported) {
  $('#compatibility').hidden = false;
  $('#compatibility').textContent = !window.isSecureContext
    ? 'Open http://localhost:8765/. USB access requires localhost or HTTPS.'
    : 'This browser does not support Web Serial. Open the address in Microsoft Edge or Google Chrome on your Mac.';
}

function render() {
  if (paused || !dirty) return;
  dirty = false;
  const source = $('#source').value, query = $('#search').value.toLowerCase();
  const visible = logs.filter(row => (source === 'all' || row.source === source) && row.message.toLowerCase().includes(query));
  const fragment = document.createDocumentFragment();
  if (!visible.length) {
    const empty = document.createElement('div'); empty.className = 'empty';
    empty.textContent = logs.length ? 'No lines match the filter.' : 'Quiet so far. Connect a USB port.';
    fragment.append(empty);
  }
  for (const row of visible) {
    const line = document.createElement('div'); line.className = `log-line ${row.kind}`;
    for (const [className, value] of [
      ['log-time', row.time.toLocaleTimeString('en-US', { hour12: false }) + '.' + String(row.time.getMilliseconds()).padStart(3, '0')],
      ['log-source', row.source === 'sender' ? 'SENDER' : row.source === 'receiver' ? 'RECEIVER' : 'SYSTEM'],
      ['log-message', row.message]
    ]) { const span = document.createElement('span'); span.className = className; span.textContent = value; line.append(span); }
    fragment.append(line);
  }
  const pane = $('#console');
  const scroll = pane.scrollTop;
  pane.replaceChildren(fragment);
  pane.scrollTop = $('#autoscroll').checked ? pane.scrollHeight : scroll;
  $('#line-count').textContent = `${visible.length} / ${logs.length} lines`;
}

function metrics() {
  renderLoad();
  communication.renderFrame();
  $('#rx-count').textContent = rxCount.toLocaleString('en-US');
  $('#counter').textContent = latestCounter === null ? '—' : latestCounter.toLocaleString('en-US');
  $('#gaps').textContent = gapCount.toLocaleString('en-US');
  const age = lastRx ? Math.floor((Date.now() - lastRx) / 1000) : null;
  $('#last-rx').textContent = age === null ? 'No CAN reception yet' : `Last RX frame ${age} s ago`;
  const anyConnected = [...devices.values()].some(device => device.port);
  const active = anyConnected && age !== null && age < 4;
  $('.bus-state').classList.toggle('active', active);
  $('#bus-label').textContent = active ? 'CAN RECEPTION CONFIRMED' : anyConnected ? 'WAITING FOR FRAMES' : 'WAITING FOR USB';
  $('#bus-detail').textContent = active ? 'RX frames are arriving. The bus is talking.' : anyConnected
    ? age === null ? 'USB is open. No CAN frames detected yet. If silent, briefly press RESET.' : 'No recent RX frames. Check the sender and wiring.'
    : 'Connect the receiver, then start the sender.';
}

for (const id of ['source', 'search', 'autoscroll']) $('#' + id).addEventListener('input', () => { dirty = true; });
$('#pause').addEventListener('click', () => {
  paused = !paused;
  $('#pause').textContent = paused ? 'Resume display' : 'Pause display';
  $('#pause').setAttribute('aria-pressed', String(paused));
  $('#capture-state').textContent = paused ? 'DISPLAY PAUSED · Recording and measurements continue' : 'LIVE · Up to 2,000 lines stored';
  dirty = true;
});
$('#clear').addEventListener('click', () => { logs = []; dirty = true; });
$('#export').addEventListener('click', () => {
  const data = logs.map(row => `${row.time.toISOString()} [${row.source}] ${row.message}`).join('\n');
  const url = URL.createObjectURL(new Blob([data + '\n'], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `canbus-${new Date().toISOString().replace(/[:.]/g, '-')}.log`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
setInterval(() => { render(); metrics(); }, 200);
log('system', 'Ready. Sender and receiver can be connected simultaneously. Selecting a port grants this page USB access.', 'system');
log('system', 'TX “ok” only means queued. Only RX frames confirm CAN reception. Counter gaps are clues, not proof of bus losses.', 'system');
