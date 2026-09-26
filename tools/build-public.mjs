import { copyFile, lstat, mkdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url));

// The complete public inventory from the verified isolated kiosk artifact.
// New public assets must be deliberately added here. Never copy the checkout,
// functions, Google source, docs, tests, private configuration, or data exports.
export const PUBLIC_FILES = Object.freeze([
  '_headers',
  '_redirects',
  'guests/index.html',
  'index.html',
  'm1/added-classes-kiosk.js',
  'm1/admin/added-classes.css',
  'm1/admin/added-classes.js',
  'm1/admin/removal-journal.js',
  'm1/admin/manager-review.js',
  'm1/admin/staff-recovery.js',
  'm1/admin/attendance-digest.js',
  'm1/admin/attendance-email.js',
  'm1/admin/read-callback-proof.js',
  'm1/admin/manager-review.css',
  'm1/manager-review-config.generated.js',
  'm1/manager-review-badge.js',
  'm1/manager-read-client.js',
  'm1/admin/index.html',
  'm1/assets/logo-sources.json',
  'm1/assets/revolution-bjj-logo.webp',
  'm1/assets/richmond-bjj-logo.webp',
  'm1/connection-check.mjs',
  'm1/connection.html',
  'm1/index.html',
  'm1/installation-profile-core.mjs',
  'm1/installation-profile.generated.js',
  'm1/kiosk-enhancements-core.mjs',
  'm1/kiosk-enhancements.css',
  'm1/kiosk-enhancements.mjs',
  'm1/production-diagnostic.html',
  'm1/promotions-client.mjs',
  'm1/promotions-config.generated.js',
  'm1/promotions-core.mjs',
  'm1/promotions-template.mjs',
  'm1/promotions-test-setup.html',
  'm1/promotions.css',
  'm1/richmond-schedule.json',
  'm1/service-worker.js',
  'm1/shared-schedule.json',
  'm1/staff-clock-client.mjs',
  'm1/staff-recovery-client.mjs',
  'm1/staff-clock-core.mjs',
  'm1/sync-core.mjs',
  'm1/tablet-diagnostic.html',
  'm1/tablet-install.html',
  'm1/temporary-classes-core.js',
  'redneck-racing/style.css'
]);

export async function buildPublic({ root = DEFAULT_ROOT } = {}) {
  const sourceRoot = await realpath(path.resolve(root));
  const publish = path.resolve(sourceRoot, 'public');
  if (path.dirname(publish) !== sourceRoot || path.basename(publish) !== 'public') {
    throw new Error('The public build destination must be directly inside the source root.');
  }
  // Validate all sources before clearing an earlier output. Refuse symlinks at
  // every source component so a tracked path cannot escape the source tree.
  for (const file of PUBLIC_FILES) {
    let source = sourceRoot;
    const segments = file.split('/');
    for (let index = 0; index < segments.length; index += 1) {
      source = path.join(source, segments[index]);
      const entry = await lstat(source);
      if (entry.isSymbolicLink() || (index < segments.length - 1 ? !entry.isDirectory() : !entry.isFile())) {
        throw new Error(`Public source must be an ordinary file inside the checkout: ${file}`);
      }
    }
  }
  const existing = await lstat(publish).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) {
    throw new Error('Refuse to replace a linked or non-directory public destination.');
  }
  // The absolute destination above is checked before this recursive removal.
  await rm(publish, { recursive: true, force: true });
  await mkdir(publish);
  for (const file of PUBLIC_FILES) {
    const destination = path.join(publish, ...file.split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(sourceRoot, ...file.split('/')), destination);
  }
  return { publish, files: [...PUBLIC_FILES] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildPublic();
  console.log(`Prepared ${result.files.length} public files.`);
}
