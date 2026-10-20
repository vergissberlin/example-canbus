import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function worker({ fetch = async () => new Response('online'), addAll = async () => {} } = {}) {
  const handlers = new Map(), stores = new Map();
  const scope = 'https://example.test/example-canbus/';
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const values = stores.get(name);
      return { addAll, async put(key, value) { values.set(key, value); }, async match(key) { return values.get(key)?.clone(); } };
    },
    async keys() { return [...stores.keys()]; },
    async delete(key) { return stores.delete(key); }
  };
  let claims = 0;
  runInNewContext(readFileSync(new URL('../sw.js', import.meta.url), 'utf8'), {
    self: { registration: { scope }, clients: { async claim() { claims++; } }, addEventListener(name, fn) { handlers.set(name, fn); } },
    URL, caches, fetch
  });
  return {
    stores, scope, handlers, claims: () => claims,
    async request(path, method = 'GET') {
      let result;
      handlers.get('fetch')({ request: new Request(new URL(path, scope), { method }), respondWith(promise) { result = promise; } });
      return result;
    },
    async lifecycle(name) {
      let result;
      handlers.get(name)({ waitUntil(promise) { result = promise; } });
      await result;
    }
  };
}

test('PWA installs only project assets and propagates incomplete precache failures', async () => {
  let urls;
  const w = worker({ addAll: async values => { urls = values; } });
  await w.lifecycle('install');
  assert.ok(urls.every(url => url.startsWith(w.scope)));
  assert.ok(urls.includes(w.scope + 'debug/app.mjs'));
  const broken = worker({ addAll: async () => { throw new Error('Missing asset'); } });
  await assert.rejects(broken.lifecycle('install'), /Missing asset/);
});

test('PWA refreshes online files and serves cached query-versioned modules offline', async () => {
  let online = true, revision = 1;
  const w = worker({ fetch: async () => { if (!online) throw new Error('Offline'); return new Response(`revision ${revision}`); } });
  assert.equal(await (await w.request('debug/app.mjs?v=first')).text(), 'revision 1');
  revision = 2;
  assert.equal(await (await w.request('debug/app.mjs?v=second')).text(), 'revision 2');
  online = false;
  assert.equal(await (await w.request('debug/app.mjs?v=second')).text(), 'revision 2');
});

test('PWA keeps other GitHub Pages projects, external traffic and writes outside its cache', async () => {
  const w = worker();
  for (const path of ['https://example.test/another-project/debug/app.mjs', 'https://external.test/', 'logs/session.log']) {
    assert.equal(await w.request(path), undefined);
  }
  assert.equal(await w.request('debug/app.mjs', 'POST'), undefined);
  assert.equal(w.stores.size, 0);
});

test('PWA activation cleans only old caches belonging to this project', async () => {
  const w = worker();
  w.stores.set('canlab:/example-canbus/:old', new Map());
  w.stores.set('canlab:/another-project/:old', new Map());
  w.stores.set('unrelated-cache', new Map());
  await w.lifecycle('activate');
  assert.equal(w.stores.has('canlab:/example-canbus/:old'), false);
  assert.equal(w.stores.has('canlab:/another-project/:old'), true);
  assert.equal(w.stores.has('unrelated-cache'), true);
  assert.equal(w.claims(), 1);
});

test('PWA manifest icons exist with their declared PNG dimensions', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.start_url, './debug/');
  assert.equal(manifest.scope, './');
  for (const icon of manifest.icons) {
    const png = readFileSync(new URL('../' + icon.src, import.meta.url));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, icon.sizes);
  }
});
