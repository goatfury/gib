import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Execute the shipped loader, replacing only its network import boundary.
const html = readFileSync(new URL('../m1/index.html', import.meta.url), 'utf8');
const startMarker = '// OPTIONAL_PROMOTIONS_LOADER_START';
const endMarker = '// OPTIONAL_PROMOTIONS_LOADER_END';

function loaderSource() {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, 'the actual optional loader block must be present');
  return html.slice(start + startMarker.length, end).replace(/\bimport\s*\(/gu, 'importModule(');
}

class Target {
  listeners = new Map();
  addEventListener(type, callback, options = {}) {
    const entries = this.listeners.get(type) || [];
    entries.push({ callback, once: options.once === true });
    this.listeners.set(type, entries);
  }
  fire(type) {
    const event = { type, target: this };
    for (const entry of [...(this.listeners.get(type) || [])]) {
      if (entry.once) this.listeners.set(type, this.listeners.get(type).filter(item => item !== entry));
      entry.callback(event);
    }
    this[`on${type}`]?.(event);
  }
}

async function flush() {
  for (let count = 0; count < 8; count += 1) await Promise.resolve();
}

function harness(readyState = 'loading') {
  const document = new Target();
  document.readyState = readyState;
  const hiddenElements = new Map(['promotionsNavigation', 'promotionsPanel'].map(id => [id, { hidden: true }]));
  document.getElementById = id => hiddenElements.get(id) || null;
  const imports = [];
  const styles = [];
  const order = [];
  document.createElement = tag => {
    assert.equal(tag, 'link', 'the optional loader should create only its stylesheet');
    const link = new Target();
    link.setAttribute = (name, value) => { link[name] = String(value); };
    return link;
  };
  document.head = {
    appendChild(link) { styles.push(link); order.push('stylesheet'); return link; },
    append(link) { this.appendChild(link); }
  };
  const context = vm.createContext({
    document,
    importModule(specifier) {
      order.push(specifier.includes('config') ? 'config' : 'client');
      return new Promise((resolve, reject) => imports.push({ specifier, resolve, reject, mediaAtImport: styles[0]?.media }));
    }
  });
  vm.runInContext(loaderSource(), context);
  return {
    document, context, imports, styles, order,
    start() { document.readyState = 'interactive'; document.fire('DOMContentLoaded'); },
    async configure(value) {
      context.M1_PROMOTIONS_TEST_CONFIG = value;
      imports[0].resolve({});
      await flush();
    },
    hidden() {
      for (const [id, element] of hiddenElements) assert.equal(element.hidden, true, `${id} stays hidden until the client mounts`);
    }
  };
}

test('optional assets are absent from parser-blocking tags and loader registration follows the installed kiosk guard', () => {
  assert.doesNotMatch(html, /<(?:script|link)\b[^>]*(?:promotions-config\.generated\.js|promotions-client\.mjs|promotions\.css)/iu);
  assert.ok(html.indexOf(startMarker) > html.indexOf('globalThis.M1_KIOSK_NAVIGATION = Object.freeze'), 'core navigation is installed before optional loading is registered');
  assert.doesNotMatch(loaderSource(), /\bawait\s+importModule\s*\(/u, 'core startup must never await optional assets');
});

test('optional repair assets use one matching version across loader and client dependencies', () => {
  const client = readFileSync(new URL('../m1/promotions-client.mjs', import.meta.url), 'utf8');
  const versions = [...`${html}\n${client}`.matchAll(/promotions(?:-config\.generated\.js|\.css|-client\.mjs|-template\.mjs|-core\.mjs)\?v=([^'"]+)/gu)].map(match => match[1]);
  assert.equal(versions.length,5);
  assert.equal(new Set(versions).size,1);
  assert.match(versions[0],/promotions-repair/u);
});

test('pending config starts only after DOMContentLoaded and cannot load CSS/client or expose the log', async () => {
  const h = harness();
  assert.equal(h.imports.length, 0);
  assert.equal(h.styles.length, 0);
  h.hidden();
  h.start(); await flush();
  assert.equal(h.imports.length, 1);
  assert.match(h.imports[0].specifier, /promotions-config\.generated\.js/u);
  assert.equal(h.styles.length, 0);
  h.hidden();
  h.document.fire('DOMContentLoaded');
  await flush();
  assert.equal(h.imports.length, 1, 'the one-shot DOMContentLoaded listener cannot duplicate the pending config import');
});

test('failed config is caught while CSS/client stay absent and the log stays hidden', async () => {
  const h = harness(); h.start(); await flush();
  h.imports[0].reject(new Error('Fictional missing config asset')); await flush();
  assert.equal(h.imports.length, 1);
  assert.equal(h.styles.length, 0);
  h.hidden();
});

test('disabled config finishes without requesting CSS or client', async () => {
  const h = harness(); h.start(); await flush();
  await h.configure({ enabled: false });
  assert.deepEqual(h.order, ['config']);
  assert.equal(h.styles.length, 0);
  h.hidden();
});

test('enabled config adds nonblocking CSS and a pending or failed stylesheet cannot start the client', async () => {
  const h = harness(); h.start(); await flush();
  await h.configure({ enabled: true, testOnly: true, endpoint: '/api/m1-promotions' });
  assert.equal(h.styles.length, 1);
  const css = h.styles[0];
  assert.equal(css.rel, 'stylesheet');
  assert.equal(css.media, 'not all');
  assert.match(css.href, /promotions\.css/u);
  assert.equal(h.imports.length, 1, 'a hanging stylesheet cannot release the client import');
  h.hidden();
  css.fire('error'); await flush();
  assert.equal(h.imports.length, 1);
  h.hidden();
});

for (const outcome of ['success', 'failure']) test(`successful asset order releases the client after CSS; client ${outcome} remains isolated`, async () => {
  const h = harness(); h.start(); await flush();
  await h.configure({ enabled: true, testOnly: true, endpoint: '/api/m1-promotions' });
  assert.deepEqual(h.order, ['config', 'stylesheet']);
  h.styles[0].fire('load'); await flush();
  assert.equal(h.styles[0].media, 'all');
  assert.deepEqual(h.order, ['config', 'stylesheet', 'client']);
  assert.match(h.imports[1].specifier, /promotions-client\.mjs/u);
  assert.equal(h.imports[1].mediaAtImport, 'all', 'CSS is enabled before the client can mount');
  if (outcome === 'failure') h.imports[1].reject(new Error('Fictional missing client asset'));
  else h.imports[1].resolve({});
  await flush();
  h.styles[0].fire('load'); await flush();
  assert.equal(h.imports.length, 2, 'the stylesheet load listener also runs once');
  h.hidden();
});

test('a page already complete starts once without requiring a DOMContentLoaded event', async () => {
  const h = harness('complete'); await flush();
  assert.equal(h.imports.length, 1);
  assert.match(h.imports[0].specifier, /promotions-config\.generated\.js/u);
  h.document.fire('DOMContentLoaded');
  await flush();
  assert.equal(h.imports.length, 1);
  await h.configure({ enabled: false });
  h.hidden();
});
