import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function verifyReleaseRuntime({ artifact, cliRoot, runtime, installation, archiveHashes }) {
  assert.ok(['rev', 'richmond'].includes(installation));
  const nodeVersion = execFileSync(runtime, ['--version'], { encoding: 'utf8' }).trim();
  assert.match(nodeVersion, /^v22\./, 'Use the actual production runtime major.');
  const cliRequire = createRequire(resolve(cliRoot, 'package.json'));
  const { default: extract } = await import(pathToFileURL(cliRequire.resolve('extract-zip')).href);
  const manifest = JSON.parse(await readFile(resolve(artifact, 'manifest.json'), 'utf8'));
  assert.equal(manifest.functions.length, 34);
  const base = tmpdir(), isolated = await mkdtemp(join(base, 'gib-release-archives-'));
  // Do not inherit service credentials, NODE_PATH, NODE_OPTIONS or preloaders.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|TEMP|TMP|HOME|USERPROFILE)$/i.test(key)));
  const results = [];
  try {
    for (const fn of manifest.functions) {
      assert.match(fn.name, /^[a-z0-9-]+$/); assert.equal(fn.runtimeVersion, 'nodejs22.x');
      const archive = resolve(artifact, fn.path);
      assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), archiveHashes[fn.name]);
      const directory = resolve(isolated, fn.name); await mkdir(directory);
      await extract(archive, { dir: directory });
      const probe = resolve(directory, 'runtime-probe.mjs');
      await copyFile(fileURLToPath(new URL('./m1-release-runtime-probe.mjs', import.meta.url)), probe);
      let result;
      try {
        result = execFileSync(runtime, [probe, resolve(directory, '___netlify-entry-point.mjs'), fn.name, installation], {
          cwd: directory, env, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (error) {
        const category = String(error.stderr || '').split('\n').find(line => /^(?:Error(?: \[[\w_]+\])?|ReferenceError|TypeError|AssertionError(?: \[[\w_]+\])?|SyntaxError):/.test(line));
        throw new Error('Archive runtime failed: ' + fn.name + ': ' + (category || error.code || 'probe failed'));
      }
      results.push(JSON.parse(result.trim()));
    }
    assert.ok(results.filter(value => value.storageImported).length > 0, 'Real storage-library import chain must be exercised.');
    assert.equal(results.find(value => value.name === 'm1-added-classes').addedClassRead, true);
    return { nodeVersion, archiveCount: results.length, isolatedFromCheckout: true, realNetworkRequests: 0, results };
  } finally {
    assert.equal(dirname(isolated), base);
    await rm(isolated, { recursive: true, force: true });
  }
}
