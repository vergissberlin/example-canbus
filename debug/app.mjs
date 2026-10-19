import { parseLine, counterGap, LineBuffer } from './protocol.mjs';

const $ = selector => document.querySelector(selector);
const MAX_LINES = 2000;
const devices = new Map();
let logs = [], paused = false, dirty = true;
let rxCount = 0, gapCount = 0, latestCounter = null, lastRx = 0;
const supported = 'serial' in navigator && window.isSecureContext;

function log(source, message, kind = null) {
  if (!message.trim()) return;
  const parsed = parseLine(message);
  logs.push({ time: new Date(), source, message, kind: kind || parsed.kind });
  if (logs.length > MAX_LINES) logs.splice(0, logs.length - MAX_LINES);
  const device = devices.get(source);
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
  device.card.classList.toggle('connected', state === 'connected');
  device.card.querySelector('.device-state').textContent = {
    idle: 'Nicht verbunden', connecting: 'Port auswählen / verbinden …',
    connected: 'USB verbunden', closing: 'Verbindung wird getrennt …'
  }[state];
  device.card.querySelector('.connect').disabled = !supported || state !== 'idle';
  device.card.querySelector('.disconnect').disabled = state !== 'connected';
}

function explainError(error) {
  if (error.name === 'NotFoundError') return 'Port-Auswahl abgebrochen.';
  if (error.name === 'SecurityError') return 'USB-Zugriff blockiert. Bitte diese Seite in Edge oder Chrome unter localhost öffnen.';
  if (error.name === 'NetworkError' || error.name === 'InvalidStateError') return 'Port nicht verfügbar. Andere serielle Monitore schließen und USB-Verbindung prüfen. ' + error.message;
  return error.message || String(error);
}

async function connect(device) {
  updateDevice(device, 'connecting');
  let port;
  try {
    port = await navigator.serial.requestPort();
    if ([...devices.values()].some(other => other !== device && other.port === port)) {
      throw new Error('Dieser Port ist bereits mit dem anderen Board verbunden. Bitte den zweiten ESP wählen.');
    }
    await port.open({ baudRate: 115200 });
    device.port = port;
    device.previousCounter = null;
    device.lastRx = 0;
    device.stopping = false;
    const info = port.getInfo();
    device.card.querySelector('.device-info').textContent = `USB ${info.usbVendorId?.toString(16).padStart(4, '0') || '????'}:${info.usbProductId?.toString(16).padStart(4, '0') || '????'} · 115200 Baud`;
    try { await port.setSignals({ dataTerminalReady: true }); }
    catch { log(device.name, 'DTR konnte nicht gesetzt werden. Falls keine Ausgabe erscheint, kurz RESET drücken.', 'system'); }
    updateDevice(device, 'connected');
    log(device.name, 'USB verbunden. Warte auf serielle Ausgabe …', 'system');
    device.task = read(device);
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
    try { await device.port?.close(); } catch {}
    device.port = null;
    device.stopping = false;
    updateDevice(device, 'idle');
    device.card.querySelector('.device-info').textContent = 'USB-Port im Browser auswählen · 115200 Baud';
    log(device.name, 'USB-Verbindung beendet.', 'system');
  }
}

async function disconnect(device) {
  if (!device.port || device.stopping) return;
  device.stopping = true;
  updateDevice(device, 'closing');
  try { await device.reader?.cancel(); await device.task; }
  catch (error) { log(device.name, explainError(error), 'error'); }
}

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
    ? 'Bitte über http://localhost:8765/debug/ aufrufen. USB-Zugriff benötigt localhost oder HTTPS.'
    : 'Dieser Browser bietet keinen Web-Serial-Zugriff. Bitte die Adresse in Microsoft Edge oder Google Chrome auf deinem Mac öffnen.';
}

function render() {
  if (paused || !dirty) return;
  dirty = false;
  const source = $('#source').value, query = $('#search').value.toLowerCase();
  const visible = logs.filter(row => (source === 'all' || row.source === source) && row.message.toLowerCase().includes(query));
  const fragment = document.createDocumentFragment();
  if (!visible.length) {
    const empty = document.createElement('div'); empty.className = 'empty';
    empty.textContent = logs.length ? 'Keine Zeilen passen zum Filter.' : 'Noch ganz still hier. Verbinde einen USB-Port.';
    fragment.append(empty);
  }
  for (const row of visible) {
    const line = document.createElement('div'); line.className = `log-line ${row.kind}`;
    for (const [className, value] of [
      ['log-time', row.time.toLocaleTimeString('de-DE', { hour12: false }) + '.' + String(row.time.getMilliseconds()).padStart(3, '0')],
      ['log-source', row.source === 'sender' ? 'SENDER' : row.source === 'receiver' ? 'RECEIVER' : 'SYSTEM'],
      ['log-message', row.message]
    ]) { const span = document.createElement('span'); span.className = className; span.textContent = value; line.append(span); }
    fragment.append(line);
  }
  const pane = $('#console');
  const scroll = pane.scrollTop;
  pane.replaceChildren(fragment);
  pane.scrollTop = $('#autoscroll').checked ? pane.scrollHeight : scroll;
  $('#line-count').textContent = `${visible.length} / ${logs.length} Zeilen`;
}

function metrics() {
  $('#rx-count').textContent = rxCount.toLocaleString('de-DE');
  $('#counter').textContent = latestCounter === null ? '—' : latestCounter.toLocaleString('de-DE');
  $('#gaps').textContent = gapCount.toLocaleString('de-DE');
  const age = lastRx ? Math.floor((Date.now() - lastRx) / 1000) : null;
  $('#last-rx').textContent = age === null ? 'Noch kein CAN-Empfang' : `Letztes RX-Frame vor ${age} s`;
  const anyConnected = [...devices.values()].some(device => device.port);
  const active = anyConnected && age !== null && age < 4;
  $('.bus-state').classList.toggle('active', active);
  $('#bus-label').textContent = active ? 'CAN-EMPFANG BESTÄTIGT' : anyConnected ? 'WARTE AUF FRAMES' : 'WARTE AUF USB';
  $('#bus-detail').textContent = active ? 'RX-Frames kommen an. Der Bus spricht.' : anyConnected
    ? age === null ? 'USB ist offen. Noch keine CAN-Frames erkannt. Bei Stille kurz RESET drücken.' : 'Keine aktuellen RX-Frames. Sender und Verkabelung prüfen.'
    : 'Receiver verbinden, dann den Sender starten.';
}

for (const id of ['source', 'search', 'autoscroll']) $('#' + id).addEventListener('input', () => { dirty = true; });
$('#pause').addEventListener('click', () => {
  paused = !paused;
  $('#pause').textContent = paused ? 'Anzeige fortsetzen' : 'Anzeige pausieren';
  $('#pause').setAttribute('aria-pressed', String(paused));
  $('#capture-state').textContent = paused ? 'ANZEIGE PAUSIERT · Aufzeichnung und Messwerte laufen weiter' : 'LIVE · maximal 2000 Zeilen gespeichert';
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
log('system', 'Bereit. Sender und Receiver können gleichzeitig verbunden werden. Die Auswahl eines Ports gibt dieser Seite USB-Zugriff.', 'system');
log('system', 'TX „ok“ bedeutet nur eingereiht. Erst RX-Frames bestätigen CAN-Empfang. Zählersprünge sind Hinweise, kein sicherer Nachweis für Busverluste.', 'system');
