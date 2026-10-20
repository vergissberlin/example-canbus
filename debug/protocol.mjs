// Parse only complete serial log lines from the existing Arduino sketches.
export function parseLine(line) {
  const rx = line.match(/^RX ID 0x([\da-f]+) DLC (\d+) Data:((?:\s+[\da-f]{2})*)(?:\s+\(Counter=(\d+)\))?\s*$/i);
  if (rx) {
    const id = Number.parseInt(rx[1], 16);
    const dlc = Number(rx[2]);
    const bytes = rx[3].trim() ? rx[3].trim().split(/\s+/).map(v => Number.parseInt(v, 16)) : [];
    if (dlc > 8 || bytes.length !== dlc || id > 0x1fffffff) return { kind: 'text' };
    // Decode payload instead of trusting the optional printed counter.
    const counter = id === 0x123 && dlc === 4
      ? (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0 : null;
    return { kind: 'rx', id, dlc, bytes, counter };
  }
  if (/^TX #\d+ -> ok$/.test(line)) return { kind: 'queued' };
  if (/\bERROR\b|^TWAI start failed$|Bus-Off|Recovery/i.test(line)) return { kind: 'error' };
  if (/waiting for frames/i.test(line)) return { kind: 'waiting' };
  return { kind: 'text' };
}

export function counterGap(previous, current) {
  if (previous === null || current === previous) return 0;
  const difference = (current - previous) >>> 0;
  // A backwards jump is most likely a reset, not billions of lost frames.
  return difference < 0x80000000 ? Math.max(0, difference - 1) : 0;
}

export class LineBuffer {
  constructor() { this.pending = ''; }
  push(chunk) {
    const parts = (this.pending + chunk).split(/\n/);
    this.pending = parts.pop();
    const result = parts.map(line => line.replace(/\r$/, ''));
    if (this.pending.length > 16384) {
      result.push(this.pending.slice(0, 16384) + ' [line truncated]');
      this.pending = '';
    }
    return result;
  }
  flush() { const last = this.pending; this.pending = ''; return last; }
}
