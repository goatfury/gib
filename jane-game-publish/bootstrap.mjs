import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';

// This temporary bridge is on an unmerged branch. It never publishes GiB.
const target = '9a0d0579-bfc4-44a6-b60b-69bc297e3513';
const expected = '8f8eb58fef07480a3c8fab35f5f0380ebe0292e61eaa3c5ba208d47f970b07de';
const destination = resolve('jane-game-artifact');
const names = ['dist/index.html','dist/_headers','netlify/functions/host.mts','lib/puzzles.mjs','package.json','netlify.toml'];
const encoded = (await Promise.all([1,2,3].map(n => readFile(`jane-game-publish/part-${n}.b64`, 'utf8')))).map(s => s.trim()).join('');
const files = JSON.parse(gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8'));
if (Object.keys(files).sort().join('|') !== [...names].sort().join('|')) throw new Error('Unexpected artifact file list');
for (const name of names) {
  if (typeof files[name] !== 'string') throw new Error('Invalid artifact content');
  const path = resolve(destination, name);
  await mkdir(dirname(path), {recursive:true});
  await writeFile(path, files[name]);
}
if (createHash('sha256').update(files['dist/index.html']).digest('hex') !== expected) throw new Error('Game checksum mismatch');
console.log('Jane Game artifact reconstructed and checksum verified.');
if (process.env.CONTEXT !== 'deploy-preview') throw new Error('This temporary bridge is preview-only. Do not merge.');
if (process.env.SITE_ID !== 'f748e737-11e3-4fab-8e8c-bf185eab29ff') {
  console.log('Artifact preview only; this site is not the authorized publishing bridge.');
} else {
  const proxy = process.env.JANE_GAME_PROXY_20260917;
  if (!proxy || !proxy.startsWith('https://netlify-mcp.netlify.app/proxy/')) throw new Error('Temporary Jane publishing credential unavailable');
  console.log('Publishing only the separate Jane Game project.');
  // Capture output: never echo the credential even if a child prints arguments.
  const result = await new Promise((res, rej) => {
    const child = spawn('npx', ['-y','@netlify/mcp@latest','--site-id',target,'--proxy-path',proxy], {cwd:destination, stdio:['ignore','pipe','pipe']});
    let output = '';
    child.stdout.on('data', d => {output += d.toString();});
    child.stderr.on('data', d => {output += d.toString();});
    const timeout = setTimeout(() => {child.kill('SIGTERM');rej(new Error('Jane deploy exceeded its time limit'));}, 720000);
    child.on('error', e => {clearTimeout(timeout);rej(e);});
    child.on('close', code => {clearTimeout(timeout);res({code,output});});
  });
  const clean = result.output.split(proxy).join('[redacted credential]').replace(/https:\/\/netlify-mcp\.netlify\.app\/proxy\/\S+/g, '[redacted credential]');
  console.log(clean);
  if (result.code !== 0) throw new Error(`Jane deploy failed with exit ${result.code}`);
  let verified = false;
  for (let i = 0; i < 18; i++) {
    try {
      const response = await fetch(`https://jane-game-play.netlify.app/?verification=${Date.now()}`, {signal:AbortSignal.timeout(15000)});
      if (response.ok && createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex') === expected) {verified = true; break;}
    } catch {}
    await new Promise(r => setTimeout(r, 5000));
  }
  if (!verified) throw new Error('Public Jane Game bytes did not verify');
  console.log('PUBLIC_GAME_VERIFIED https://jane-game-play.netlify.app SHA256 '+expected);
}
