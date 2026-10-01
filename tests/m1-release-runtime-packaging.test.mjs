import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

for (const transitive of [false, true]) test(`archive gate detects missing ${transitive ? 'transitive' : 'direct'} storage dependency before deployment`, async () => {
  const base = tmpdir(), root = await mkdtemp(join(base, 'gib-broken-storage-'));
  try {
    await copyFile(new URL('../tools/m1-release-runtime-probe.mjs', import.meta.url), join(root, 'probe.mjs'));
    await writeFile(join(root, '___netlify-entry-point.mjs'), "const bootstrap = {getLambdaHandler() {}}; bootstrap.getLambdaHandler('./function.mjs');");
    // The handler catches the error just as the retained failed archive did.
    // The separate real import gate must still detect it.
    await writeFile(join(root, 'function.mjs'), "export async function handler() { try { return await import('@netlify/blobs'); } catch { return {status:503}; } }");
    if (transitive) {
      await mkdir(join(root, 'node_modules/@netlify/blobs'), { recursive: true });
      await writeFile(join(root, 'node_modules/@netlify/blobs/package.json'), JSON.stringify({ name: '@netlify/blobs', type: 'module', main: 'index.mjs' }));
      await writeFile(join(root, 'node_modules/@netlify/blobs/index.mjs'), "import '@netlify/otel'; export const getStore = () => {}; ");
    }
    const result = spawnSync(process.execPath, [join(root, 'probe.mjs'), join(root, '___netlify-entry-point.mjs'), 'fixture', 'rev'], {
      cwd: root, encoding: 'utf8', env: { SystemRoot: process.env.SystemRoot || '' }
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /MODULE_NOT_FOUND/);
    assert.match(result.stderr, transitive ? /@netlify\/otel/ : /@netlify\/blobs/);
  } finally {
    assert.equal(dirname(root), base); await rm(root, { recursive: true, force: true });
  }
});
