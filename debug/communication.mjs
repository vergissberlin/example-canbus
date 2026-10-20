import { message, t, translate, onLanguageChange } from './i18n.mjs';
const BOARDS = ['sender', 'receiver'];
const isBoard = source => BOARDS.includes(source);

// A queue acknowledgement is not proof of traffic on CANH/CANL.
export function signalWires(source, event) {
  if (!isBoard(source)) return [];
  if (event.kind === 'usb') return [`${source}-usb`];
  if (event.kind === 'queued') return [`${source}-tx`];
  if (event.kind === 'rx') return ['canh', 'canl', `${source}-rx`];
  return [];
}

export class CommunicationView {
  constructor({ schedule = (fn, delay) => setTimeout(fn, delay), cancel = timer => clearTimeout(timer), now = Date.now } = {}) {
    this.schedule = schedule;
    this.cancel = cancel;
    this.now = now;
    this.root = null;
    this.pulses = new Map();
    this.boards = new Map(BOARDS.map(name => [name, { connected: false, error: false, status: 'Not connected' }]));
    this.lastFrame = null;
    onLanguageChange(() => {
      for (const name of BOARDS) this.renderBoard(name);
      this.renderFrame();
    });
  }

  attach(root) {
    this.clearPulses();
    this.root = root;
    for (const name of BOARDS) this.renderBoard(name);
    this.renderFrame();
  }

  connection(source, connected) {
    if (!isBoard(source)) return;
    const board = this.boards.get(source);
    board.connected = connected;
    board.error = false;
    board.status = connected ? 'USB connected' : 'Not connected';
    // Shared bus highlights survive only if another board still owns them.
    this.clearPulses(source);
    this.renderBoard(source);
  }

  event(source, event) {
    if (!isBoard(source)) return;
    const board = this.boards.get(source);
    if (!board.connected) return;
    if (event.kind === 'error') {
      board.error = true;
      board.status = 'Error · Check log';
      this.clearPulses(source);
    } else if (event.kind === 'rx') {
      board.error = false;
      board.status = 'RX detected';
      this.lastFrame = { source, id: event.id, counter: event.counter, time: this.now() };
      this.renderFrame();
    } else if (event.kind === 'queued' && !board.error) {
      board.status = 'TX queued';
    }
    for (const wire of signalWires(source, event)) this.pulse(wire, source);
    this.renderBoard(source);
  }

  pulse(wire, source) {
    const element = this.root?.querySelector(`[data-wire="${wire}"]`);
    if (!element) return;
    const current = this.pulses.get(wire);
    // Do not restart or extend pulses: bursts cannot enqueue animations.
    if (current) { current.owners.add(source); return; }
    element.classList.add('pulse-active');
    const timer = this.schedule(() => {
      element.classList.remove('pulse-active');
      this.pulses.delete(wire);
    }, 400);
    this.pulses.set(wire, { element, timer, owners: new Set([source]) });
  }

  clearPulses(source = null) {
    for (const [wire, pulse] of this.pulses) {
      if (source !== null) {
        pulse.owners.delete(source);
        if (pulse.owners.size) continue;
      }
      this.cancel(pulse.timer);
      pulse.element.classList.remove('pulse-active');
      this.pulses.delete(wire);
    }
  }

  renderBoard(source) {
    const board = this.boards.get(source);
    const node = this.root?.querySelector(`[data-node="${source}"]`);
    node?.classList.toggle('is-connected', board.connected);
    node?.classList.toggle('has-error', board.error);
    const label = this.root?.querySelector(`[data-node-status="${source}"]`);
    if (label) { label.textContent = t(board.status); label.setAttribute('fill', board.error ? '#c44836' : '#617167'); }
  }

  renderFrame() {
    const label = this.root?.querySelector('[data-last-frame]');
    const age = this.root?.querySelector('[data-frame-age]');
    if (!this.lastFrame) return;
    const { id, counter, source, time } = this.lastFrame;
    if (label) label.textContent = `RX 0x${id.toString(16).toUpperCase().padStart(3, '0')}${counter === null ? '' : ` · #${counter}`}`;
    if (age) age.textContent = t('{role} · {age} s ago', { role: message(source === 'sender' ? 'Sender' : 'Receiver'), age: Math.max(0, Math.floor((this.now() - time) / 1000)) });
  }
}

export async function loadCommunication(host, view, fetchSvg = fetch) {
  try {
    const response = await fetchSvg(new URL('../docs/canbus-communication.svg?v=builtin-termination', import.meta.url));
    if (!response.ok) throw new Error(`SVG HTTP ${response.status}`);
    const parsed = new DOMParser().parseFromString(await response.text(), 'image/svg+xml');
    if (parsed.querySelector('parsererror') || parsed.documentElement.localName !== 'svg') throw new Error('Invalid SVG');
    // This is a bundled, same-origin asset; serial log text never becomes markup.
    const root = document.importNode(parsed.documentElement, true);
    host.replaceChildren(root);
    translate(root);
    view.attach(root);
    return true;
  } catch {
    const renderFailure = () => { host.textContent = t('Could not load the signal diagram. The WebSerial console below still works.'); };
    renderFailure();
    onLanguageChange(renderFailure);
    host.classList.add('diagram-unavailable');
    return false;
  }
}
