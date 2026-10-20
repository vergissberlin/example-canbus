import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLine, counterGap, LineBuffer } from './protocol.mjs';
test('RX counter is decoded little endian from bytes', () => {
  assert.equal(parseLine('RX ID 0x123 DLC 4 Data: FF 00 01 00  (Counter=65791)').counter, 65791);
  assert.equal(parseLine('RX ID 0x123 DLC 4 Data: FF FF FF FF').counter, 4294967295);
  assert.equal(parseLine('RX ID 0x124 DLC 4 Data: 01 00 00 00').counter, null);
});
test('invalid frames never count as received CAN data', () => {
  for (const line of ['RX ID 0x123 DLC 4 Data: 01 00', 'RX ID 0x123 DLC 9 Data: 01 02 03 04 05 06 07 08 09', 'RX ID 0x20000000 DLC 0 Data:']) {
    assert.equal(parseLine(line).kind, 'text');
  }
});
test('TX queue status does not confirm reception', () => {
  assert.equal(parseLine('TX #42 -> ok').kind, 'queued');
  assert.equal(parseLine('TX #42 -> ERROR (peer/wiring?)').kind, 'error');
  assert.equal(parseLine('Bus-Off -> Recovery').kind, 'error');
  assert.equal(parseLine('... waiting for frames').kind, 'waiting');
});
test('counter gaps handle startup, duplicates, reset, and uint32 wrap', () => {
  assert.equal(counterGap(null, 100), 0);
  assert.equal(counterGap(100, 100), 0);
  assert.equal(counterGap(100, 103), 2);
  assert.equal(counterGap(100, 0), 0);
  assert.equal(counterGap(4294967295, 0), 0);
  assert.equal(counterGap(4294967294, 1), 2);
});
test('serial chunks can split lines and CRLF at arbitrary positions', () => {
  const buffer = new LineBuffer();
  assert.deepEqual(buffer.push('RX ID 0x1'), []);
  assert.deepEqual(buffer.push('23\r'), []);
  assert.deepEqual(buffer.push('\nsecond\nthird'), ['RX ID 0x123', 'second']);
  assert.equal(buffer.flush(), 'third');
  assert.equal(buffer.flush(), '');
});
test('unterminated serial noise is bounded', () => {
  const buffer = new LineBuffer();
  assert.match(buffer.push('x'.repeat(17000))[0], /line truncated/);
  assert.equal(buffer.pending, '');
});

test('English firmware errors are recognized without false telemetry errors', () => {
  for (const line of ['TWAI start failed', 'TX #42 -> ERROR (peer/wiring?)']) {
    assert.equal(parseLine(line).kind, 'error');
  }
  for (const line of ['LAB STATS role=sender failed=0 errors=0', 'DIAG TX_ACK=1 BUS_ERROR=0']) {
    assert.equal(parseLine(line).kind, 'text');
  }
});
