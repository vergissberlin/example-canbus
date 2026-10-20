// USB command protocol and load-test state. No CAN throughput is inferred from USB timing.
const ROLES = ['sender', 'receiver'];
const UINT32_MAX = 0xffffffff;
export function settings(rate, seconds) {
  const fps = Number(rate), duration = Number(seconds);
  if (!Number.isInteger(fps) || fps < 1 || fps > 20000) throw new Error('Choose an integer frame rate from 1 to 20,000 frames/s.');
  if (!Number.isInteger(duration) || duration < 1 || duration > 60) throw new Error('Choose a test duration from 1 to 60 seconds.');
  return { rate: fps, seconds: duration };
}
export function parseLabLine(line) {
  const match = /^LAB (HELLO|ACK|STATS|END|ERROR) (.+)$/.exec(line);
  if (!match || line.length > 1024) return null;
  const values = Object.create(null);
  for (const token of match[2].split(' ')) {
    const field = /^([a-z_]+)=([A-Za-z0-9_]+)$/.exec(token);
    if (!field || field[1] === 'type' || Object.hasOwn(values, field[1])) return null;
    values[field[1]] = field[2];
  }
  if (!ROLES.includes(values.role)) return null;
  const strings = ['role', 'command', 'reason'];
  for (const [key, value] of Object.entries(values)) {
    if (strings.includes(key)) continue;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > UINT32_MAX) return null;
    values[key] = Number(value);
  }
  const type = match[1].toLowerCase();
  const required = type === 'hello' ? ['version', 'bitrate']
    : type === 'ack' ? ['test', 'command']
    : type === 'end' ? ['test', 'reason']
    : type === 'error' ? ['reason']
    : values.role === 'sender'
      ? ['test', 'running', 'target', 'queued', 'queued_fps', 'rejected', 'skipped', 'cancelled', 'pending', 'failed', 'errors', 'tec', 'rec', 'state', 'elapsed_ms']
      : ['test', 'rx', 'rx_fps', 'counter', 'gaps', 'duplicates', 'missed', 'overrun', 'errors', 'tec', 'rec', 'state', 'elapsed_ms'];
  if (required.some(key => !Object.hasOwn(values, key))) return null;
  if (type === 'stats' && (values.state > 3 || (values.role === 'sender' && values.running > 1))) return null;
  return { type, ...values };
}

export class LoadTest {
  constructor({ send, changed = () => {}, now = Date.now, schedule = (fn, ms) => setTimeout(fn, ms), cancel = id => clearTimeout(id) }) {
    this.send = send; this.changed = changed; this.now = now; this.schedule = schedule; this.cancel = cancel;
    this.boards = Object.fromEntries(ROLES.map(role => [role, { connected: false, ready: false }]));
    this.pending = new Map(); this.session = null; this.active = false; this.busy = false;
    this.message = 'Connect both boards. The load test requires CAN-LAB firmware.';
    this.nextId = this.now() >>> 0;
    this.epoch = 0;
  }
  get ready() { return ROLES.every(role => this.boards[role].connected && this.boards[role].ready); }
  connection(role, connected) {
    this.boards[role] = { connected, ready: false };
    if (!connected) {
      this.epoch++;
      for (const [key, pending] of this.pending) if (key.startsWith(role + ':')) {
        this.cancel(pending.timer); this.pending.delete(key); pending.reject(new Error('USB connection lost.'));
      }
      if (this.active || this.busy) {
        this.active = false;
        this.message = 'Connection lost. Stop requested; the firmware also limits the test to its duration.';
        if (role !== 'sender' && this.boards.sender.connected) void this.send('sender', 'LAB STOP').catch(() => {});
      }
    }
    this.changed();
  }
  async identify(role) {
    try { await this.send(role, 'LAB HELLO'); }
    catch { this.message = 'USB writing unavailable. The load test remains disabled.'; this.changed(); }
  }
  accept(role, event) {
    if (!event || !this.boards[role].connected) return false;
    if (event.role !== role) {
      this.boards[role].ready = false;
      this.message = 'Sender and receiver are swapped. Disconnect the ports and assign them to the correct cards.';
      this.changed(); return false;
    }
    if (event.type === 'hello') {
      this.boards[role].ready = event.version === 1 && event.bitrate === 500000;
      this.message = this.ready ? 'Ready · 500 kbit/s · Load frames with 8 data bytes.' : 'Waiting for compatible CAN-LAB firmware on both boards.';
    }
    if (event.type === 'ack') {
      const key = role + ':' + event.command, pending = this.pending.get(key);
      if (pending && (pending.test === null || pending.test === event.test)) {
        this.cancel(pending.timer); this.pending.delete(key); pending.resolve(event);
      }
    }
    if (event.type === 'error') {
      this.message = `${role === 'sender' ? 'Sender' : 'Receiver'} rejected the command: ${event.reason}`;
      for (const [key, pending] of this.pending) if (key.startsWith(role + ':')) {
        this.cancel(pending.timer); this.pending.delete(key); pending.reject(new Error(this.message));
      }
    }
    if (this.session && event.test === this.session.id) {
      if (event.type === 'stats') {
        this.session[role === 'sender' ? 'tx' : 'rx'] = event;
        this.session.updated = this.now();
        const samples = this.session.samples;
        // Ignore zero-length startup windows, duplicates and frozen sender timestamps after STOP.
        const previous = samples.findLast(sample => sample.role === role);
        if (event.elapsed_ms > (previous?.elapsed ?? 0)) {
          samples.push({ role, elapsed: event.elapsed_ms, fps: role === 'sender' ? event.queued_fps : event.rx_fps });
          const cutoff = Math.max(...samples.map(sample => sample.elapsed)) - 60000;
          this.session.samples = samples.filter(sample => sample.elapsed >= cutoff);
        }
      }
      if (event.type === 'end') {
        this.active = false; this.session.reason = event.reason;
        this.message = event.reason === 'timeout' ? 'Test duration reached. Sender stopped; final reception measurements are still arriving.'
          : event.reason === 'stop' ? 'Sender stopped; final reception measurements are still arriving.' : `Test ended: ${event.reason}`;
      }
    }
    this.changed(); return true;
  }
  request(role, command, acknowledgement, test = null) {
    const key = role + ':' + acknowledgement;
    if (this.pending.has(key)) {
      if (acknowledgement !== 'stop') return Promise.reject(new Error('Command already in progress.'));
      const old = this.pending.get(key); this.cancel(old.timer); this.pending.delete(key);
      old.reject(new Error('Start canceled by stop.'));
    }
    return new Promise((resolve, reject) => {
      const timer = this.schedule(() => {
        this.pending.delete(key); reject(new Error('No firmware acknowledgement. Check the connection and firmware.'));
      }, 3000);
      this.pending.set(key, { resolve, reject, timer, test });
      Promise.resolve().then(() => this.send(role, command)).catch(error => {
        const pending = this.pending.get(key);
        if (pending) { this.cancel(pending.timer); this.pending.delete(key); pending.reject(error); }
      });
    });
  }
  async start(rate, seconds) {
    const chosen = settings(rate, seconds);
    if (!this.ready || this.busy || this.active) throw new Error('Both matching boards must be connected and ready.');
    this.busy = true; this.message = 'Preparing receiver and starting sender …'; this.changed();
    const epoch = ++this.epoch;
    const stillCurrent = () => { if (epoch !== this.epoch) throw new Error('Start canceled by stop or disconnect.'); };
    const id = this.nextId = ((this.nextId + 1) >>> 0) || 1;
    this.session = { id, rate: chosen.rate, seconds: chosen.seconds, tx: null, rx: null, samples: [], updated: 0, reason: null };
    try {
      // Stop the boot demo before arming so its old frames cannot pollute the run.
      await this.request('sender', 'LAB STOP', 'stop');
      stillCurrent();
      await this.request('receiver', `LAB ARM ${id}`, 'arm', id);
      stillCurrent();
      await this.request('sender', `LAB START ${id} ${chosen.rate} ${chosen.seconds}`, 'start', id);
      stillCurrent();
      this.active = this.session.reason === null;
      this.message = this.active ? 'Load test running. The configured rate is a target, not confirmed bus throughput.' : this.message;
    } catch (error) {
      this.active = false; this.message = error.message;
      // START may have reached the device even when its acknowledgement was lost.
      if (this.boards.sender.connected) await this.send('sender', 'LAB STOP').catch(() => {});
      throw error;
    } finally { this.busy = false; this.changed(); }
  }
  async rate(rate) {
    const chosen = settings(rate, this.session?.seconds ?? 10);
    if (!this.active || this.busy) throw new Error('No load test running.');
    this.busy = true; this.changed();
    try {
      await this.request('sender', `LAB RATE ${this.session.id} ${chosen.rate}`, 'rate', this.session.id);
      this.session.rate = chosen.rate;
      this.message = 'New target rate acknowledged; the original test duration is unchanged.';
    } catch (error) { this.message = error.message; throw error; }
    finally { this.busy = false; this.changed(); }
  }
  async stop() {
    if (!this.boards.sender.connected) throw new Error('Sender not connected.');
    this.epoch++;
    // STOP stays available even if another command is awaiting a reply.
    this.message = 'Requesting stop …'; this.changed();
    try {
      await this.request('sender', 'LAB STOP', 'stop');
      this.active = false; this.message = 'Sender acknowledged stop. Final reception measurements are still arriving.';
    } catch (error) { this.message = 'Stop not acknowledged. The firmware ends the test no later than the selected duration.'; throw error; }
    finally { this.changed(); }
  }
}

// Device elapsed time, never USB arrival order, determines the horizontal position.
export function timeline(samples = []) {
  const end = Math.max(60000, ...samples.map(sample => sample.elapsed));
  const start = end - 60000;
  const visible = samples.filter(sample => sample.elapsed >= start && sample.elapsed <= end);
  const maximum = Math.max(1, ...visible.map(sample => sample.fps));
  const x = elapsed => 58 + (elapsed - start) / 60000 * 562;
  const y = fps => 160 - fps / maximum * 130;
  const paths = {};
  for (const role of ROLES) {
    let previous;
    paths[role] = visible.filter(sample => sample.role === role).map(sample => {
      const move = !previous || sample.elapsed - previous.elapsed > 1500;
      previous = sample;
      return `${move ? 'M' : 'L'}${x(sample.elapsed).toFixed(2)} ${y(sample.fps).toFixed(2)}${move ? 'h0' : ''}`;
    }).join(' ');
  }
  return { start, end, maximum, paths, points: visible.map(sample => ({ ...sample, x: x(sample.elapsed), y: y(sample.fps) })) };
}
