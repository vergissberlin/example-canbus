import { german } from './translations.mjs';

export const STORAGE_KEY = 'canlab.language';
export function detectLanguage(languages, language = 'en') {
  const candidates = Array.isArray(languages) && languages.length ? languages : [language];
  for (const candidate of candidates) {
    const base = String(candidate).toLowerCase().split(/[-_]/)[0];
    if (base === 'de' || base === 'en') return base;
  }
  return 'en';
}
const valid = value => ['auto', 'de', 'en'].includes(value);
export function createLanguage({ navigator: nav = {}, storage, changed = () => {} } = {}) {
  let preference = 'auto';
  try { const saved = storage?.getItem(STORAGE_KEY); if (valid(saved)) preference = saved; } catch { /* Session-only selection. */ }
  const language = () => preference === 'auto' ? detectLanguage(nav.languages, nav.language) : preference;
  return {
    get preference() { return preference; },
    get language() { return language(); },
    select(value) {
      if (!valid(value)) return;
      preference = value;
      try { storage?.setItem(STORAGE_KEY, value); } catch { /* Session-only selection. */ }
      changed();
    }
  };
}
const listeners = new Set();
let storage;
try { storage = globalThis.localStorage; } catch { /* Browser may deny storage access. */ }
export const language = createLanguage({ navigator: globalThis.navigator, storage, changed: () => refresh() });
export const locale = () => language.language === 'de' ? 'de-DE' : 'en-US';
export const number = (value, digits) => new Intl.NumberFormat(locale(), digits === undefined ? {} : { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
export const message = (key, params = {}) => ({ key, params });
export function text(value, lang = language.language) {
  if (typeof value !== 'object' || value === null || !value.key) return String(value ?? '');
  const template = lang === 'de' ? german[value.key] ?? value.key : value.key;
  return template.replace(/\{(\w+)\}/g, (_, key) => text(value.params[key] ?? `{${key}}`, lang));
}
export const t = (key, params) => text(message(key, params));
export class LocalizedError extends Error {
  constructor(key, params) {
    const descriptor = typeof key === 'object' ? key : message(key, params);
    super(text(descriptor, 'en'));
    this.descriptor = descriptor;
  }
}
export const errorMessage = error => error.descriptor ?? error.message ?? String(error);
export const onLanguageChange = callback => { listeners.add(callback); return () => listeners.delete(callback); };

// Bind text nodes individually, preserving controls, event handlers, SVGs and emphasis.
// Only bundled UI is passed here: serial output must never be translated as UI.
const seen = new WeakSet(), bindings = new Set();
export function translate(root) {
  const doc = root.ownerDocument ?? root;
  const walker = doc.createTreeWalker(root, 4);
  let node;
  while ((node = walker.nextNode())) {
    if (seen.has(node) || node.parentElement?.closest('script, style, #console')) continue;
    seen.add(node);
    const key = node.textContent.trim();
    if (!Object.hasOwn(german, key)) continue;
    const prefix = node.textContent.match(/^\s*/)[0], suffix = node.textContent.match(/\s*$/)[0];
    bindings.add({ node, key, prefix, suffix });
  }
  for (const element of root.querySelectorAll('[aria-label], [placeholder], meta[name="description"]')) {
    if (seen.has(element)) continue;
    seen.add(element);
    for (const attr of ['aria-label', 'placeholder', 'content']) {
      const key = element.getAttribute(attr);
      if (Object.hasOwn(german, key)) bindings.add({ node: element, attr, key });
    }
  }
  applyBindings();
}
function applyBindings() {
  for (const binding of bindings) {
    const { node, attr, key, prefix, suffix } = binding;
    if (!node.isConnected) { bindings.delete(binding); continue; }
    if (attr) node.setAttribute(attr, t(key));
    else node.textContent = prefix + t(key) + suffix;
  }
}
function refresh() {
  if (globalThis.document) {
    document.documentElement.lang = language.language;
    applyBindings();
    for (const select of document.querySelectorAll('[data-language]')) select.value = language.preference;
    for (const button of document.querySelectorAll('[data-load-rate]')) button.textContent = number(Number(button.dataset.loadRate));
  }
  for (const callback of listeners) callback();
}
export function initLanguage(doc = document) {
  translate(doc);
  for (const select of doc.querySelectorAll('[data-language]')) select.addEventListener('change', () => language.select(select.value));
  refresh();
}
if (globalThis.document) {
  initLanguage();
  globalThis.addEventListener('languagechange', () => { if (language.preference === 'auto') refresh(); });
}
