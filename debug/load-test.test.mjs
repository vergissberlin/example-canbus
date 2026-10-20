import test from 'node:test';
import assert from 'node:assert/strict';
import { settings, parseLabLine, LoadTest } from './load-test.mjs';
const hello = role => parseLabLine(`LAB HELLO role=${role} version=1 bitrate=500000 max_rate=20000 max_seconds=60`);
const tx = (id, extra = '') => parseLabLine(`LAB STATS role=sender test=${id} running=1 target=1000 queued=1000 queued_fps=1000 rejected=10 skipped=0 cancelled=0 pending=3 failed=0 errors=0 tec=0 rec=0 state=1 elapsed_ms=1000${extra}`);
const rx = id => parseLabLine(`LAB STATS role=receiver test=${id} rx=997 rx_fps=997 counter=996 gaps=0 duplicates=0 missed=0 overrun=0 errors=0 tec=0 rec=0 state=1 elapsed_ms=1000`);
function harness({ answer = true } = {}) {
  const commands = []; let timeout; let next = 0;
  const timers = new Map();
  const controller = new LoadTest({ now: () => 100,
    schedule(fn) { timers.set(++next, fn); timeout = fn; return next; }, cancel(id) { timers.delete(id); },
    async send(role, command) {
      commands.push({ role, command });
      if (!answer) return;
      const words = command.split(' '), operation = words[1].toLowerCase();
      controller.accept(role, { type: 'ack', role, command: operation, test: words[2] ? Number(words[2]) : 0 });
    }
  });
  for (const role of ['sender', 'receiver']) { controller.connection(role, true); controller.accept(role, hello(role)); }
  return { controller, commands, timers, timeout: () => timeout() };
}
test('load settings reject rates and durations outside a bounded integral range', () => {
  assert.deepEqual(settings('20000', '60'), { rate: 20000, seconds: 60 });
  for (const rate of [0, -1, 20001, 1.5, 'x', Infinity]) assert.throws(() => settings(rate, 10));
  for (const duration of [0, 61, 1.5, 'x']) assert.throws(() => settings(100, duration));
});
test('strict telemetry parser separates queue offers, receiver counts and errors', () => {
  const sender = tx(10), receiver = rx(10);
  assert.equal(sender.queued, 1000); assert.equal(sender.rejected, 10);
  assert.equal(receiver.rx, 997); assert.equal(receiver.gaps, 0);
  for (const invalid of [
    'LAB HELLO role=other version=1 bitrate=500000',
    'LAB ACK role=sender command=start test=-1',
    'LAB ACK role=sender command=start test=4294967296',
    'LAB ACK role=sender command=start test=1 test=2',
    'LAB STATS role=receiver test=10 rx=999',
    'LAB ACK role=sender command=start test=1 type=1'
  ]) assert.equal(parseLabLine(invalid), null);
});
test('start waits for stop and receiver ARM acknowledgements before sending START', async () => {
  const { controller: c, commands } = harness();
  await c.start(1000, 10);
  assert.deepEqual(commands.map(x => x.command), ['LAB STOP', 'LAB ARM 101', 'LAB START 101 1000 10']);
  assert.equal(c.active, true); assert.equal(c.session.rx, null);
  c.accept('sender', tx(101)); assert.equal(c.session.rx, null, 'TX must never synthesize RX');
  c.accept('receiver', rx(101)); assert.equal(c.session.rx.rx, 997);
});
test('stale and foreign test reports cannot replace current measurements', async () => {
  const { controller: c } = harness(); await c.start(1000, 10);
  c.accept('receiver', rx(99)); assert.equal(c.session.rx, null);
  c.accept('receiver', rx(101)); c.accept('receiver', rx(101));
  assert.equal(c.session.samples.length, 1);
  assert.equal(c.session.rx.rx_fps, 997);
});
test('wrong board assignment and unsupported firmware keep start disabled', () => {
  const { controller: c } = harness();
  c.accept('sender', hello('receiver')); assert.equal(c.ready, false);
  c.accept('sender', { ...hello('sender'), version: 2 }); assert.equal(c.ready, false);
});
test('rate applies only after matching acknowledgement and preserves duration', async () => {
  const { controller: c, commands } = harness(); await c.start(1000, 10);
  await c.rate(5000); assert.equal(c.session.rate, 5000); assert.equal(c.session.seconds, 10);
  assert.equal(commands.at(-1).command, 'LAB RATE 101 5000');
  await c.stop(); assert.equal(c.active, false);
  await assert.rejects(() => c.rate(100));
});
test('timeout end keeps the final measurements and permits a new test', async () => {
  const { controller: c } = harness(); await c.start(1000, 10);
  c.accept('receiver', rx(101)); c.accept('sender', { type: 'end', role: 'sender', test: 101, reason: 'timeout' });
  assert.equal(c.active, false); assert.equal(c.session.rx.rx, 997);
  await c.start(100, 2); assert.equal(c.session.id, 102); assert.equal(c.session.rx, null);
});
test('receiver disconnect requests sender stop without inventing final success', async () => {
  const { controller: c, commands } = harness(); await c.start(1000, 10);
  c.connection('receiver', false); await Promise.resolve();
  assert.equal(c.active, false); assert.equal(c.ready, false);
  assert.equal(commands.at(-1).command, 'LAB STOP');
  assert.match(c.message, /unterbrochen/);
});
test('missing acknowledgements fail startup and send cleanup STOP', async () => {
  const h = harness({ answer: false });
  const run = h.controller.start(1000, 10);
  await Promise.resolve(); h.timeout();
  await assert.rejects(run, /Bestätigung/);
  assert.equal(h.controller.active, false); assert.equal(h.commands.at(-1).command, 'LAB STOP');
});
test('STOP during startup cancels the sequence before ARM or START can be issued', async () => {
  const h = harness({ answer: false });
  const start = h.controller.start(1000, 10);
  const rejected = assert.rejects(start, /abgebrochen/);
  await Promise.resolve();
  const stop = h.controller.stop();
  await Promise.resolve();
  h.controller.accept('sender', { type: 'ack', role: 'sender', command: 'stop', test: 0 });
  await stop; await rejected;
  assert(!h.commands.some(x => /LAB (ARM|START)/.test(x.command)));
});
