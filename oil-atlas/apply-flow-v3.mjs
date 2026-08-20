import { createHash } from 'node:crypto';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const expectedSha256 = 'c1d0bd1d66122725fb517a2d91c2dfb9e977d99284f13e94d0cf363cb2531da2';

const safePath = (relativePath) => {
  const outputPath = resolve(root, relativePath);
  if (!outputPath.startsWith(`${root}${sep}`)) throw new Error(`Unsafe output path: ${relativePath}`);
  return outputPath;
};

const parseHunkHeader = (line) => {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match) throw new Error(`Invalid patch hunk header: ${line}`);
  return {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
  };
};

const blockMatchesAt = (lines, block, index) => {
  if (index < 0 || index + block.length > lines.length) return false;
  for (let i = 0; i < block.length; i += 1) {
    if (lines[index + i] !== block[i]) return false;
  }
  return true;
};

const locateExactBlock = (lines, block, expected, file) => {
  if (block.length === 0) return Math.max(0, Math.min(lines.length, expected));
  if (blockMatchesAt(lines, block, expected)) return expected;

  const matches = [];
  for (let i = 0; i <= lines.length - block.length; i += 1) {
    if (blockMatchesAt(lines, block, i)) matches.push(i);
  }
  if (!matches.length) {
    throw new Error(
      `Exact Gulf-flow hunk block not found in ${file}; expected near line ${expected + 1}; first expected line ${JSON.stringify(block[0])}; actual ${JSON.stringify(lines[expected])}`,
    );
  }
  matches.sort((a, b) => Math.abs(a - expected) - Math.abs(b - expected));
  if (matches.length > 1 && Math.abs(matches[0] - expected) === Math.abs(matches[1] - expected)) {
    throw new Error(`Ambiguous Gulf-flow hunk in ${file} near line ${expected + 1}`);
  }
  return matches[0];
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

    let current = [];
    if (oldPath !== '/dev/null') {
      const originalText = (await readFile(safePath(oldPath), 'utf8')).replace(/\r\n/g, '\n');
      current = originalText.endsWith('\n') ? originalText.slice(0, -1).split('\n') : originalText.split('\n');
      if (current.length === 1 && current[0] === '') current = [];
    }

    let sawHunk = false;
    let cumulativeDelta = 0;

    while (i < lines.length && !lines[i].startsWith('--- ')) {
      if (!lines[i]) { i += 1; continue; }
      if (!lines[i].startsWith('@@ ')) throw new Error(`Expected patch hunk for ${targetRelative}, got: ${lines[i]}`);
      sawHunk = true;
      const { oldStart, oldCount, newCount } = parseHunkHeader(lines[i]);
      i += 1;

      const oldBlock = [];
      const newBlock = [];
      let usedOld = 0;
      let usedNew = 0;
      while (usedOld < oldCount || usedNew < newCount) {
        if (i >= lines.length) throw new Error(`Patch ended inside a hunk for ${targetRelative}`);
        const patchLine = lines[i];
        if (patchLine === '\\ No newline at end of file') { i += 1; continue; }
        const prefix = patchLine[0];
        const content = patchLine.slice(1);
        if (prefix === ' ') {
          oldBlock.push(content);
          newBlock.push(content);
          usedOld += 1;
          usedNew += 1;
        } else if (prefix === '-') {
          oldBlock.push(content);
          usedOld += 1;
        } else if (prefix === '+') {
          newBlock.push(content);
          usedNew += 1;
        } else {
          throw new Error(`Invalid patch line in ${targetRelative}: ${patchLine}`);
        }
        i += 1;
      }

      const nominal = (oldStart === 0 ? 0 : oldStart - 1) + cumulativeDelta;
      const at = locateExactBlock(current, oldBlock, nominal, targetRelative);
      current.splice(at, oldBlock.length, ...newBlock);
      cumulativeDelta += newBlock.length - oldBlock.length;
    }

    if (!sawHunk) throw new Error(`Patch contains no hunks for ${targetRelative}`);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, `${current.join('\n')}\n`, 'utf8');
    patchedFiles += 1;
  }

  return patchedFiles;
};

const patchDir = resolve(root, 'patches');
const parts = (await readdir(patchDir))
  .filter((name) => /^gulf-flow-v3-\d+\.b64$/.test(name))
  .sort();
if (parts.length !== 6) throw new Error(`Expected 6 Gulf flow patch chunks, found ${parts.length}`);

let encoded = '';
for (const part of parts) encoded += (await readFile(resolve(patchDir, part), 'utf8')).trim();
const compressed = Buffer.from(encoded, 'base64');
const actualHash = createHash('sha256').update(compressed).digest('hex');
if (actualHash !== expectedSha256) throw new Error(`Gulf flow patch checksum mismatch: ${actualHash}`);

let patchBuffer;
try {
  patchBuffer = gunzipSync(compressed);
} catch (error) {
  // The legacy, content-addressed bundle has a malformed gzip trailer. Its exact
  // bytes remain SHA-pinned above. Every patch hunk is still matched as an exact,
  // unique source block before any file is written.
  const standardHeader = compressed.length > 18
    && compressed[0] === 0x1f && compressed[1] === 0x8b
    && compressed[2] === 0x08 && compressed[3] === 0x00;
  if (!standardHeader || error?.code !== 'Z_DATA_ERROR') throw error;
  patchBuffer = inflateRawSync(compressed.subarray(10, -8));
  console.warn('Recovered the SHA-pinned Gulf flow patch from its legacy malformed gzip trailer.');
}

const patchedFiles = await applyUnifiedPatch(patchBuffer.toString('utf8'));
console.log(`Applied the smooth Gulf route-flow model to ${patchedFiles} files.`);
