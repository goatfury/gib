// Runs inside one extracted archive. Only HTTP is simulated: library imports,
// request serialization and conditional-write handling use the real SDK.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const [entry, name, gym] = process.argv.slice(2);
assert.ok(entry && name && ['rev', 'richmond'].includes(gym));
const root = dirname(resolve(entry));
const bootstrap = await readFile(entry, 'utf8');
const relative = bootstrap.match(/getLambdaHandler\(['"]([^'"]+)['"]\)/)?.[1];
assert.ok(relative, 'Unrecognized archive entry; review the packager change.');
const main = resolve(root, relative);
assert.ok(main.startsWith(root + sep), 'Archive entry escapes extraction.');
// Lambda supplies this streaming wrapper in production. Reproduce only the
// wrapper registration; do not replace application code or its storage SDK.
globalThis.awslambda = { streamifyResponse: handler => handler };
process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({ siteID: 'isolated-runtime-test', token: 'synthetic-not-a-credential',
  apiURL: 'https://archive-storage.invalid', edgeURL: 'https://archive-storage.invalid', uncachedEdgeURL: 'https://archive-storage.invalid' })).toString('base64');
const calls = [];
let rejectConditionalWrite = false;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  assert.equal(url.origin, 'https://archive-storage.invalid', 'No real network is permitted.');
  const method = String(options.method || input.method || 'GET').toUpperCase();
  assert.ok(['GET', 'PUT'].includes(method));
  calls.push(method);
  if (method === 'PUT') return new Response(null, { status: rejectConditionalWrite ? 412 : 200, headers: { etag: 'isolated-etag' } });
  return new Response(null, { status: 404 });
};
await import(pathToFileURL(entry).href);
const module = await import(pathToFileURL(main).href);
const mainSource = await readFile(main, 'utf8');
let storageImported = false;
if (mainSource.includes('@netlify/blobs')) {
  const sdkPath = createRequire(main).resolve('@netlify/blobs');
  assert.ok(sdkPath.startsWith(root + sep), 'Storage must resolve from this archive, never a parent install.');
  const { getStore } = await import(pathToFileURL(sdkPath).href);
  storageImported = true;
  const store = getStore({ name: 'isolated-runtime-check', consistency: 'strong' });
  assert.equal(await store.getWithMetadata('isolated', { type: 'json', consistency: 'strong' }), null);
  assert.equal((await store.setJSON('isolated', { synthetic: true }, { onlyIfNew: true })).modified, true);
  rejectConditionalWrite = true;
  assert.equal((await store.setJSON('isolated', { synthetic: true }, { onlyIfNew: true })).modified, false);
}
let addedClassRead = false;
if (name === 'm1-added-classes') {
  const origin = gym === 'rev' ? 'https://gib-live.netlify.app' : 'https://gib-richmond-live.netlify.app';
  const other = gym === 'rev' ? 'https://gib-richmond-live.netlify.app' : 'https://gib-live.netlify.app';
  const context = { site: { id: gym === 'rev' ? 'f748e737-11e3-4fab-8e8c-bf185eab29ff' : '9b7757a9-70f4-4977-9ca2-270b41e34007',
    name: gym === 'rev' ? 'gib-live' : 'gib-richmond-live' }, deploy: { context: 'production', published: true } };
  const before = calls.length;
  const response = await module.default(new Request(origin + '/api/m1-added-classes'), context);
  assert.equal(response.status, 200, 'Actual archive storage read must succeed.');
  const body = await response.json();
  assert.equal(body.ok, true); assert.equal(body.current, true); assert.equal(body.gymId, gym); assert.equal(body.target, 'production');
  assert.ok(calls.length > before, 'Fake application storage must not bypass the SDK.');
  const reads = calls.length;
  assert.equal((await module.default(new Request(other + '/api/m1-added-classes'), context)).status, 403);
  assert.equal((await module.default(new Request(origin + '/api/m1-added-classes'), { ...context, deploy: { context: 'production', published: false } })).status, 403);
  assert.equal(calls.length, reads, 'Rejected scope must not reach storage.');
  addedClassRead = true;
}
console.log(JSON.stringify({ name, storageImported, addedClassRead, fakeStorageCalls: calls.length }));
