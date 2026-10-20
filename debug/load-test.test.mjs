import test from 'node:test';
import assert from 'node:assert/strict';
import { settings, parseLabLine, LoadTest, timeline } from './load-test.mjs';
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
  assert.match(c.message, /lost/);
});
test('missing acknowledgements fail startup and send cleanup STOP', async () => {
  const h = harness({ answer: false });
  const run = h.controller.start(1000, 10);
  await Promise.resolve(); h.timeout();
  await assert.rejects(run, /acknowledgement/);
  assert.equal(h.controller.active, false); assert.equal(h.commands.at(-1).command, 'LAB STOP');
});
test('STOP during startup cancels the sequence before ARM or START can be issued', async () => {
  const h = harness({ answer: false });
  const start = h.controller.start(1000, 10);
  const rejected = assert.rejects(start, /canceled/);
  await Promise.resolve();
  const stop = h.controller.stop();
  await Promise.resolve();
  h.controller.accept('sender', { type: 'ack', role: 'sender', command: 'stop', test: 0 });
  await stop; await rejected;
  assert(!h.commands.some(x => /LAB (ARM|START)/.test(x.command)));
});

test('timeline places both series by device seconds and leaves missing reports disconnected', () => {
  const chart = timeline([
    {role: 'sender', elapsed: 1000, fps: 100},
    {role: 'receiver', elapsed: 1000, fps: 90},
    {role: 'sender', elapsed: 2000, fps: 110},
    {role: 'sender', elapsed: 5000, fps: 0}
  ]);
  assert.equal(chart.end - chart.start, 60000);
  assert.equal(chart.maximum, 110);
  assert.equal(chart.points[0].x, chart.points[1].x);
  assert.ok(chart.points[2].x - chart.points[0].x < 10, 'One second must occupy 1/60 of the axis');
  assert.equal(chart.paths.sender.split('M').length - 1, 2);
  assert.match(chart.paths.receiver, /^M/);
  assert.equal(timeline([{role:'sender', elapsed:1000, fps:1}]).paths.receiver, '');
});
test('history retains sixty seconds, ignores duplicates and frozen sender timestamps', async () => {
  const {controller:c} = harness(); await c.start(1000,60);
  for (let second=0;second<=65;second++) {
    c.accept('sender', {...tx(101), elapsed_ms:second*1000});
    c.accept('receiver', {...rx(101), elapsed_ms:second*1000});
  }
  assert.equal(c.session.samples.length,122);
  const before=c.session.samples.length;
  c.accept('sender', {...tx(101), elapsed_ms:65000});
  c.accept('sender', {...tx(101), elapsed_ms:64000});
  assert.equal(c.session.samples.length,before);
  const chart=timeline(c.session.samples);
  assert.equal(chart.start,5000); assert.equal(chart.end,65000);
  assert.equal(chart.points[0].x,58);
  await c.stop(); await c.start(1000,10);
  assert.deepEqual(c.session.samples,[]);
});

test('diagnostics use per-window counter increases and pending is a gauge', async () => {
  const {controller:c} = harness(); await c.start(1000,10);
  c.accept('sender',{...tx(101),elapsed_ms:0, rejected:0,skipped:0,errors:0,pending:0});
  c.accept('sender',{...tx(101),rejected:12,skipped:3,errors:2,pending:7});
  c.accept('sender',{...tx(101),elapsed_ms:2000,rejected:16,skipped:5,errors:2,pending:1});
  c.accept('receiver',{...rx(101),gaps:4,missed:5,overrun:6,errors:7});
  assert.deepEqual(c.session.samples[0].values,{rejected:12,skipped:3,pending:7,tx_errors:2});
  assert.deepEqual(c.session.samples[1].values,{rejected:4,skipped:2,pending:1,tx_errors:0});
  assert.deepEqual(c.session.samples[2].values,{gaps:4,missed:5,overrun:6,rx_errors:7});
  const chart=timeline(c.session.samples);
  assert.equal(chart.maximum,1000); assert.equal(chart.diagnosticMaximum,12);
  assert.equal(chart.diagnosticPoints.length,12);
  assert.ok(chart.diagnosticPoints.every(point=>point.y>=205 && point.y<=300));
  const before=JSON.stringify(c.session.samples);
  c.accept('sender',{...tx(101),elapsed_ms:2000,rejected:99});
  assert.equal(JSON.stringify(c.session.samples),before);
});
test('series visibility controls scaling without deleting history or inventing receiver data', () => {
  const samples=[{role:'sender',elapsed:1000,fps:5000,values:{rejected:900,skipped:3,pending:10,tx_errors:0}}];
  const chart=timeline(samples,['skipped']);
  assert.equal(chart.maximum,1); assert.equal(chart.diagnosticMaximum,3);
  assert.equal(chart.paths.sender,'');assert.equal(chart.paths.receiver,'');
  assert.equal(chart.diagnosticPoints.length,1);
  assert.equal(timeline(samples).diagnosticMaximum,900);
  assert.equal(timeline(samples,[]).diagnosticPoints.length,0);
  assert.equal(samples[0].values.rejected,900);
});
test('counter resets cannot create negative deltas and long windows keep their actual duration', async () => {
  const {controller:c}=harness();await c.start(1000,10);
  c.accept('sender',{...tx(101),rejected:20});
  c.accept('sender',{...tx(101),elapsed_ms:4000,rejected:1});
  assert.equal(c.session.samples[1].values.rejected,0);
  assert.equal(c.session.samples[1].span,3000);
  assert.equal(timeline(c.session.samples).paths.rejected.split('M').length-1,2);
});

test('automatic demo starts with only a compatible sender and waits for its acknowledgement', async () => {
  const {controller:c,commands}=harness();
  c.connection('receiver',false);
  c.accept('sender',{...hello('sender'),demo:1});
  await c.demo();
  assert.deepEqual(commands.map(item=>item.command),['LAB DEMO']);
  assert.equal(c.active,false);
  assert.equal(c.busy,false);
  assert.equal(c.session,null);
});
test('automatic demo cannot override a load test or run on unsupported firmware', async () => {
  const {controller:c,commands}=harness();
  await assert.rejects(()=>c.demo());
  assert.equal(commands.length,0);
  c.accept('sender',{...hello('sender'),demo:1});
  await c.start(100,10);
  const count=commands.length;
  await assert.rejects(()=>c.demo());
  assert.equal(commands.length,count);
});

test('post-stop measurement windows extend the queued-rate curve down to measured zero', async () => {
  const {controller:c}=harness();await c.start(1000,10);
  c.accept('sender',{...tx(101),elapsed_ms:9000});
  c.accept('sender',{...tx(101),running:0,elapsed_ms:10000,queued:2000});
  c.accept('sender',{type:'end',role:'sender',test:101,reason:'timeout'});
  c.accept('sender',{...tx(101),running:0,elapsed_ms:11000,queued:2000,queued_fps:0,pending:0});
  const chart=timeline(c.session.samples);
  const points=chart.points.filter(point=>point.series==='sender');
  assert.deepEqual(points.map(point=>point.value),[1000,1000,0]);
  assert.equal(points.at(-1).elapsed,11000);
  assert.equal(chart.paths.sender.split('M').length-1,1,'Stop must not create a missing-data gap');
  assert.equal(c.active,false);
});

test('bus-off recovery announces the demo without restarting or changing the ended load test', async () => {
  const {controller:c,commands}=harness();await c.start(1000,10);
  c.accept('sender',tx(101));
  c.accept('sender',{type:'end',role:'sender',test:101,reason:'bus_off'});
  const count=commands.length;
  const recovery=parseLabLine('LAB RECOVERED role=sender test=101 demo=1');
  assert.equal(recovery.type,'recovered');
  c.accept('sender',recovery);
  assert.equal(c.active,false);
  assert.equal(c.session.reason,'bus_off');
  assert.equal(c.session.rate,1000);
  assert.equal(commands.length,count);
  assert.match(c.message,/Demo resumed at 1 frame\/s/);
});

test('recovery notice follows bus-off, recovered demo and explicit stop', async () => {
  const {controller:c}=harness();await c.start(100,10);
  assert.equal(c.recovery,null);
  c.accept('sender',{...tx(101),state:2});
  assert.equal(c.recovery,'recovering');
  c.accept('sender',{type:'end',role:'sender',test:101,reason:'bus_off'});
  c.accept('sender',parseLabLine('LAB RECOVERED role=sender test=101 demo=1'));
  assert.equal(c.recovery,'recovered');
  await c.stop();
  assert.equal(c.recovery,null);
});
