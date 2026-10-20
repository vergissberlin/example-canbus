import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage, createLanguage, STORAGE_KEY, language, message, text, number, LocalizedError } from './i18n.mjs';
import { german } from './translations.mjs';
import { LoadTest } from './load-test.mjs';

test('automatic selection uses the first supported preferred language and regional variants', () => {
  for (const [languages, fallback, expected] of [
    [['de-AT'], 'en', 'de'], [['en-GB', 'de'], 'de', 'en'], [['fr', 'de-CH', 'en'], 'en', 'de'],
    [['ja', 'fr'], 'de', 'en'], [[], 'de-DE', 'de'], [undefined, 'en-US', 'en'], [undefined, undefined, 'en']
  ]) assert.equal(detectLanguage(languages, fallback), expected);
});

test('manual selection persists, restores and returns to automatic selection', () => {
  const values = new Map(); let changes = 0;
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const options = { navigator: { languages: ['de-DE'] }, storage, changed: () => changes++ };
  const state = createLanguage(options);
  assert.equal(state.preference, 'auto'); assert.equal(state.language, 'de');
  state.select('en'); assert.equal(state.language, 'en'); assert.equal(values.get(STORAGE_KEY), 'en');
  assert.equal(createLanguage(options).language, 'en');
  state.select('auto'); assert.equal(state.language, 'de');
  assert.equal(createLanguage(options).preference, 'auto');
  state.select('invalid'); assert.equal(changes, 2);
  values.set(STORAGE_KEY, 'broken'); assert.equal(createLanguage(options).preference, 'auto');
});

test('blocked storage still allows manual language changes during the session', () => {
  const state = createLanguage({ navigator: { language: 'de' }, storage: {
    getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }
  } });
  state.select('en'); assert.equal(state.language, 'en');
  state.select('auto'); assert.equal(state.language, 'de');
});

test('catalog preserves all placeholders and nested parameters remain literal text', () => {
  const placeholders = value => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const [en, de] of Object.entries(german)) assert.deepEqual(placeholders(en), placeholders(de), en);
  assert.equal(text(message('{role} rejected the command: {reason}', { role: message('Receiver'), reason: '<script>' }), 'de'), 'Empfänger hat den Befehl abgewiesen: <script>');
  assert.equal(text(message('Future message'), 'de'), 'Future message');
});

test('existing load status and errors can be retranslated without changing control state', () => {
  const commands = [];
  const load = new LoadTest({ send: (...args) => commands.push(args) });
  const error = new LocalizedError('Sender not connected.');
  language.select('de');
  assert.equal(load.message, 'Beide Boards verbinden. Der Lasttest benötigt die CAN-LAB-Firmware.');
  assert.equal(text(error.descriptor), 'Sender nicht verbunden.');
  assert.equal(number(20000), '20.000'); assert.equal(number(1.5, 1), '1,5');
  language.select('en');
  assert.equal(load.message, 'Connect both boards. The load test requires CAN-LAB firmware.');
  assert.equal(number(20000), '20,000');
  assert.deepEqual(commands, []); assert.equal(load.active, false);
});
