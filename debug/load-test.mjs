// USB command protocol and load-test state. No CAN throughput is inferred from USB timing.
const ROLES = ['sender', 'receiver'];
const UINT32_MAX = 0xffffffff;
export function settings(rate, seconds) {
  const fps = Number(rate), duration = Number(seconds);
  if (!Number.isInteger(fps) || fps < 1 || fps > 20000) throw new Error('Bitte eine ganze Framerate von 1 bis 20.000 Frames/s wählen.');
  if (!Number.isInteger(duration) || duration < 1 || duration > 60) throw new Error('Bitte eine Testdauer von 1 bis 60 Sekunden wählen.');
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
    this.message = 'Beide Boards verbinden. Der Lasttest benötigt CAN-LAB-Firmware.';
    this.nextId = this.now() >>> 0;
    this.epoch = 0;
  }
  get ready() { return ROLES.every(role => this.boards[role].connected && this.boards[role].ready); }
  connection(role, connected) {
    this.boards[role] = { connected, ready: false };
    if (!connected) {
      this.epoch++;
      for (const [key, pending] of this.pending) if (key.startsWith(role + ':')) {
        this.cancel(pending.timer); this.pending.delete(key); pending.reject(new Error('USB-Verbindung unterbrochen.'));
      }
      if (this.active || this.busy) {
        this.active = false;
        this.message = 'Verbindung unterbrochen. Stopp angefordert; die Firmware begrenzt den Test zusätzlich auf seine Laufzeit.';
        if (role !== 'sender' && this.boards.sender.connected) void this.send('sender', 'LAB STOP').catch(() => {});
      }
    }
    this.changed();
  }
  async identify(role) {
    try { await this.send(role, 'LAB HELLO'); }
    catch { this.message = 'USB-Schreiben nicht verfügbar. Lasttest bleibt deaktiviert.'; this.changed(); }
  }
  accept(role, event) {
    if (!event || !this.boards[role].connected) return false;
    if (event.role !== role) {
      this.boards[role].ready = false;
      this.message = 'Sender und Receiver sind vertauscht. Ports trennen und den richtigen Karten zuordnen.';
      this.changed(); return false;
    }
    if (event.type === 'hello') {
      this.boards[role].ready = event.version === 1 && event.bitrate === 500000;
      this.message = this.ready ? 'Bereit · 500 kbit/s · Lastframes mit 8 Datenbytes.' : 'Warte auf kompatible CAN-LAB-Firmware auf beiden Boards.';
    }
    if (event.type === 'ack') {
      const key = role + ':' + event.command, pending = this.pending.get(key);
      if (pending && (pending.test === null || pending.test === event.test)) {
        this.cancel(pending.timer); this.pending.delete(key); pending.resolve(event);
      }
    }
    if (event.type === 'error') {
      this.message = `${role === 'sender' ? 'Sender' : 'Receiver'} lehnt den Befehl ab: ${event.reason}`;
      for (const [key, pending] of this.pending) if (key.startsWith(role + ':')) {
        this.cancel(pending.timer); this.pending.delete(key); pending.reject(new Error(this.message));
      }
    }
    if (this.session && event.test === this.session.id) {
      if (event.type === 'stats') {
        this.session[role === 'sender' ? 'tx' : 'rx'] = event;
        this.session.updated = this.now();
        if (role === 'receiver') {
          const samples = this.session.samples;
          if (!samples.length || samples.at(-1).elapsed !== event.elapsed_ms) {
            samples.push({ elapsed: event.elapsed_ms, fps: event.rx_fps });
            if (samples.length > 30) samples.shift();
          }
        }
      }
      if (event.type === 'end') {
        this.active = false; this.session.reason = event.reason;
        this.message = event.reason === 'timeout' ? 'Testdauer erreicht. Sender gestoppt; letzte Empfangswerte laufen noch ein.'
          : event.reason === 'stop' ? 'Sender gestoppt; letzte Empfangswerte laufen noch ein.' : `Test beendet: ${event.reason}`;
      }
    }
    this.changed(); return true;
  }
  request(role, command, acknowledgement, test = null) {
    const key = role + ':' + acknowledgement;
    if (this.pending.has(key)) {
      if (acknowledgement !== 'stop') return Promise.reject(new Error('Befehl wird bereits bearbeitet.'));
      const old = this.pending.get(key); this.cancel(old.timer); this.pending.delete(key);
      old.reject(new Error('Start durch Stopp abgebrochen.'));
    }
    return new Promise((resolve, reject) => {
      const timer = this.schedule(() => {
        this.pending.delete(key); reject(new Error('Keine Firmware-Bestätigung. Verbindung und Firmware prüfen.'));
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
    if (!this.ready || this.busy || this.active) throw new Error('Beide passenden Boards müssen verbunden und bereit sein.');
    this.busy = true; this.message = 'Receiver vorbereiten und Sender starten …'; this.changed();
    const epoch = ++this.epoch;
    const stillCurrent = () => { if (epoch !== this.epoch) throw new Error('Start durch Stopp oder Trennen abgebrochen.'); };
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
      this.message = this.active ? 'Lasttest läuft. Die eingestellte Rate ist eine Zielrate, keine bestätigte Busleistung.' : this.message;
    } catch (error) {
      this.active = false; this.message = error.message;
      // START may have reached the device even when its acknowledgement was lost.
      if (this.boards.sender.connected) await this.send('sender', 'LAB STOP').catch(() => {});
      throw error;
    } finally { this.busy = false; this.changed(); }
  }
  async rate(rate) {
    const chosen = settings(rate, this.session?.seconds ?? 10);
    if (!this.active || this.busy) throw new Error('Kein laufender Lasttest.');
    this.busy = true; this.changed();
    try {
      await this.request('sender', `LAB RATE ${this.session.id} ${chosen.rate}`, 'rate', this.session.id);
      this.session.rate = chosen.rate;
      this.message = 'Neue Zielrate bestätigt; die ursprüngliche Testdauer bleibt bestehen.';
    } catch (error) { this.message = error.message; throw error; }
    finally { this.busy = false; this.changed(); }
  }
  async stop() {
    if (!this.boards.sender.connected) throw new Error('Sender nicht verbunden.');
    this.epoch++;
    // STOP stays available even if another command is awaiting a reply.
    this.message = 'Stopp wird angefordert …'; this.changed();
    try {
      await this.request('sender', 'LAB STOP', 'stop');
      this.active = false; this.message = 'Sender hat Stopp bestätigt. Letzte Empfangswerte laufen noch ein.';
    } catch (error) { this.message = 'Stopp nicht bestätigt. Die Firmware beendet den Test spätestens nach der gewählten Dauer.'; throw error; }
    finally { this.changed(); }
  }
}
