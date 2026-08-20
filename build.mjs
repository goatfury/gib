import { createHash } from 'node:crypto';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const payloadDir = resolve(root, 'payload');
const expectedBrotliSha256 = '339d45936486417cef79a079e5e7d08bad6f20b5c9ed976faffa7ae5eeb9fb4a';
const expectedPatchSha256 = '8f407759c983e876a407c5c1e8906b7b0fd328f6029f6e09aab2094adc89f508';

const safePath = (relativePath) => {
  const outputPath = resolve(root, relativePath);
  if (!outputPath.startsWith(`${root}${sep}`)) throw new Error(`Unsafe output path: ${relativePath}`);
  return outputPath;
};

const parts = (await readdir(payloadDir))
  .filter((name) => /^payload-\d+\.b64$/.test(name))
  .sort();
if (!parts.length) throw new Error('Oil Atlas payload chunks are missing');

let encoded = '';
for (const part of parts) encoded += (await readFile(resolve(payloadDir, part), 'utf8')).trim();
const compressed = Buffer.from(encoded, 'base64');
const actualHash = createHash('sha256').update(compressed).digest('hex');
if (actualHash !== expectedBrotliSha256) {
  throw new Error(`Oil Atlas payload checksum mismatch: ${actualHash}`);
}

const archive = JSON.parse(brotliDecompressSync(compressed).toString('utf8'));
if (archive.version !== 1 || !archive.files || typeof archive.files !== 'object') {
  throw new Error('Oil Atlas payload has an unsupported format');
}

for (const [relativePath, content] of Object.entries(archive.files)) {
  const outputPath = safePath(relativePath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content, 'utf8');
}

const parseHunkHeader = (line) => {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match) throw new Error(`Invalid patch hunk header: ${line}`);
  return {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
  };
};

const applyUnifiedPatch = async (patchText) => {
  const lines = patchText.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  let patchedFiles = 0;

  while (i < lines.length) {
    if (!lines[i]) { i += 1; continue; }
    if (!lines[i].startsWith('--- ')) throw new Error(`Unexpected patch line ${i + 1}: ${lines[i]}`);

    const oldPath = lines[i].slice(4).trim();
    i += 1;
    if (i >= lines.length || !lines[i].startsWith('+++ ')) throw new Error(`Missing new-file header after ${oldPath}`);
    const newPath = lines[i].slice(4).trim();
    i += 1;

    const targetRelative = newPath === '/dev/null' ? oldPath : newPath;
    if (targetRelative === '/dev/null') throw new Error('Patch cannot have /dev/null on both sides');
    const targetPath = safePath(targetRelative);

    let originalLines = [];
    if (oldPath !== '/dev/null') {
      const originalText = (await readFile(safePath(oldPath), 'utf8')).replace(/\r\n/g, '\n');
      originalLines = originalText.endsWith('\n') ? originalText.slice(0, -1).split('\n') : originalText.split('\n');
      if (originalLines.length === 1 && originalLines[0] === '') originalLines = [];
    }

    const output = [];
    let cursor = 0;
    let sawHunk = false;

    while (i < lines.length && !lines[i].startsWith('--- ')) {
      if (!lines[i]) { i += 1; continue; }
      if (!lines[i].startsWith('@@ ')) throw new Error(`Expected patch hunk for ${targetRelative}, got: ${lines[i]}`);
      sawHunk = true;
      const { oldStart, oldCount, newCount } = parseHunkHeader(lines[i]);
      i += 1;

      const oldIndex = oldStart === 0 ? 0 : oldStart - 1;
      if (oldIndex < cursor || oldIndex > originalLines.length) {
        throw new Error(`Patch hunk for ${targetRelative} starts outside the source file`);
      }
      output.push(...originalLines.slice(cursor, oldIndex));
      cursor = oldIndex;

      let usedOld = 0;
      let usedNew = 0;
      while (usedOld < oldCount || usedNew < newCount) {
        if (i >= lines.length) throw new Error(`Patch ended inside a hunk for ${targetRelative}`);
        const patchLine = lines[i];
        if (patchLine === '\\ No newline at end of file') { i += 1; continue; }
        const prefix = patchLine[0];
        const content = patchLine.slice(1);

        if (prefix === ' ') {
          if (originalLines[cursor] !== content) {
            throw new Error(`Context mismatch in ${targetRelative} at source line ${cursor + 1}`);
          }
          output.push(content);
          cursor += 1;
          usedOld += 1;
          usedNew += 1;
        } else if (prefix === '-') {
          if (originalLines[cursor] !== content) {
            throw new Error(`Deletion mismatch in ${targetRelative} at source line ${cursor + 1}`);
          }
          cursor += 1;
          usedOld += 1;
        } else if (prefix === '+') {
          output.push(content);
          usedNew += 1;
        } else {
          throw new Error(`Invalid patch line in ${targetRelative}: ${patchLine}`);
        }
        i += 1;
      }
    }

    if (!sawHunk) throw new Error(`Patch contains no hunks for ${targetRelative}`);
    output.push(...originalLines.slice(cursor));
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, `${output.join('\n')}\n`, 'utf8');
    patchedFiles += 1;
  }

  return patchedFiles;
};

const patchDir = resolve(root, 'patches');
const patchParts = (await readdir(patchDir))
  .filter((name) => /^gulf-audit-\d+\.b64$/.test(name))
  .sort();
if (!patchParts.length) throw new Error('Oil Atlas audit patch chunks are missing');
let patchEncoded = '';
for (const part of patchParts) patchEncoded += (await readFile(resolve(patchDir, part), 'utf8')).trim();
const patchCompressed = Buffer.from(patchEncoded, 'base64');
const patchHash = createHash('sha256').update(patchCompressed).digest('hex');
if (patchHash !== expectedPatchSha256) throw new Error(`Oil Atlas audit patch checksum mismatch: ${patchHash}`);
const patchText = gunzipSync(patchCompressed).toString('utf8');
const patchedFiles = await applyUnifiedPatch(patchText);

console.log(`Reconstructed ${Object.keys(archive.files).length} Oil Flow Atlas files and applied the audited Gulf model to ${patchedFiles} files.`);
