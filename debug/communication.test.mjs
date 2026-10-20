import test from 'node:test';
import assert from 'node:assert/strict';
import { CommunicationView, signalWires, loadCommunication } from './communication.mjs';
import { parseLine } from './protocol.mjs';
import { readFileSync } from 'node:fs';

function fixture() {
  const elements = new Map();
  function element() {
    const classes = new Set();
    return { textContent: '', setAttribute() {}, classList: {
      add: name => classes.add(name), remove: name => classes.delete(name),
      contains: name => classes.has(name),
      toggle: (name, active) => active ? classes.add(name) : classes.delete(name)
    } };
  }
  const root = { querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, element());
    return elements.get(selector);
  } };
  const timers = new Map(); let id = 0, time = 1000;
  const view = new CommunicationView({
    schedule: (fn, delay) => { timers.set(++id, { fn, delay }); return id; },
    cancel: key => timers.delete(key), now: () => time
  });
  view.attach(root);
  view.connection('sender', true); view.connection('receiver', true);
  const active = wire => root.querySelector(`[data-wire="${wire}"]`).classList.contains('pulse-active');
  const expire = () => { const pending = [...timers.values()]; timers.clear(); for (const { fn } of pending) fn(); };
  return { view, root, timers, active, expire, advance: ms => time += ms };
}
const rx = parseLine('RX ID 0x123 DLC 4 Daten: 2A 00 00 00  (Zaehler=42)');

test('TX queue acknowledgement highlights only local CTX, never confirmed CAN reception', () => {
  const { view, active } = fixture();
  view.event('sender', parseLine('TX #42 -> ok'));
  assert.ok(active('sender-tx'));
  for (const wire of ['canh', 'canl', 'receiver-rx', 'sender-rx']) assert.ok(!active(wire));
  assert.equal(view.lastFrame, null);
});
test('RX highlights CAN pair and receiving board CRX, including reversed assignment', () => {
  for (const board of ['sender', 'receiver']) {
    const { view, active } = fixture(); view.event(board, rx);
    for (const wire of ['canh', 'canl', `${board}-rx`]) assert.ok(active(wire));
    assert.ok(!active(`${board}-tx`));
    assert.deepEqual(view.lastFrame, { source: board, id: 0x123, counter: 42, time: 1000 });
  }
});
test('USB chunks highlight only their own USB lead', () => {
  assert.deepEqual(signalWires('receiver', { kind: 'usb' }), ['receiver-usb']);
  const { view, active } = fixture(); view.event('receiver', { kind: 'usb' });
  assert.ok(active('receiver-usb')); assert.ok(!active('receiver-rx')); assert.equal(view.lastFrame, null);
});
test('waiting, invalid frames, and system messages do not animate CAN', () => {
  const { view, timers } = fixture();
  for (const message of ['... warte auf Frames', 'RX ID 0x123 DLC 4 Daten: 01', 'Empfaenger bereit']) view.event('receiver', parseLine(message));
  view.event('system', rx);
  assert.equal(timers.size, 0);
});
test('bus-off marks node red and cancels success pulses', () => {
  const { view, root, timers, active } = fixture();
  view.event('sender', rx); view.event('sender', parseLine('Bus-Off -> Recovery'));
  assert.equal(timers.size, 0); assert.ok(!active('canh'));
  assert.ok(root.querySelector('[data-node="sender"]').classList.contains('has-error'));
  view.event('sender', parseLine('TX #43 -> ok'));
  assert.ok(root.querySelector('[data-node="sender"]').classList.contains('has-error'));
  view.event('sender', rx);
  assert.ok(!root.querySelector('[data-node="sender"]').classList.contains('has-error'));
});
test('rapid events coalesce into one 400 ms pulse per wire, then settle', () => {
  const { view, timers, active, expire } = fixture();
  for (let i = 0; i < 1000; i++) view.event('receiver', rx);
  assert.equal(timers.size, 3);
  for (const timer of timers.values()) assert.equal(timer.delay, 400);
  expire();
  assert.equal(view.pulses.size, 0); assert.ok(!active('canh'));
  view.event('receiver', rx); assert.equal(timers.size, 3);
});
test('disconnect clears owned wires without clearing another active source', () => {
  const { view, active } = fixture();
  view.event('sender', rx); view.event('receiver', rx);
  view.connection('receiver', false);
  assert.ok(!active('receiver-rx')); assert.ok(active('canh')); assert.ok(active('sender-rx'));
  view.connection('sender', false);
  assert.equal(view.pulses.size, 0); assert.ok(!active('canh'));
  view.event('sender', rx); assert.equal(view.pulses.size, 0);
});
test('events before SVG load preserve last frame but do not replay animations', () => {
  const view = new CommunicationView();
  view.connection('receiver', true); view.event('receiver', rx);
  assert.equal(view.lastFrame.counter, 42); assert.equal(view.pulses.size, 0);
  const f = fixture(); view.attach(f.root);
  assert.match(f.root.querySelector('[data-last-frame]').textContent, /RX 0x123 · #42/);
  assert.equal(view.pulses.size, 0);
});
test('last frame age and non-counter IDs display correctly', () => {
  const { view, root, advance } = fixture();
  view.event('receiver', parseLine('RX ID 0x456 DLC 1 Daten: FF'));
  assert.equal(root.querySelector('[data-last-frame]').textContent, 'RX 0x456');
  advance(2300); view.renderFrame();
  assert.match(root.querySelector('[data-frame-age]').textContent, /Receiver · vor 2 s/);
});
test('missing SVG returns a visible fallback without throwing into WebSerial initialization', async () => {
  const host = { textContent: '', classList: { add() {} } };
  const view = new CommunicationView();
  assert.equal(await loadCommunication(host, view, async () => ({ ok: false, status: 404 })), false);
  assert.match(host.textContent, /WebSerial-Konsole/);
  assert.equal(await loadCommunication(host, view, async () => { throw new Error('offline'); }), false);
});
test('SVG defines every dynamic wire once and includes static supplies and reduced-motion fallback', () => {
  const svg = readFileSync(new URL('../docs/canbus-communication.svg', import.meta.url), 'utf8');
  const wires = [...svg.matchAll(/data-wire="([^"]+)"/g)].map(match => match[1]);
  assert.equal(wires.length, new Set(wires).size);
  for (const board of ['sender', 'receiver']) for (const kind of ['usb', 'queued', 'rx']) {
    for (const wire of signalWires(board, { kind })) assert.ok(wires.includes(wire), wire);
  }
  for (const wire of ['sender-power', 'receiver-power', 'sender-ground', 'receiver-ground', 'ground']) {
    const group = svg.match(new RegExp(`<g[^>]+data-wire="${wire}"[^>]*>(.*?)</g>`, 's'))[1];
    assert.ok(!group.includes('wire-glow'));
  }
  assert.match(svg, /prefers-reduced-motion:reduce/);
  assert.match(svg, /animation:none/);
});
