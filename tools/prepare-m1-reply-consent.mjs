// Local preparation only. No upload, credential, API, timer, or routing action.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export async function prepareReplyConsent(root, output) {
  const result = [];
  for (const [gym, folder] of [['rev', 'production'], ['richmond', 'richmond-production']]) {
    const manifest = JSON.parse(await readFile(resolve(root, 'integrations/google-apps-script', folder, 'appsscript.json'), 'utf8'));
    manifest.oauthScopes = [...new Set([...manifest.oauthScopes, 'https://www.googleapis.com/auth/gmail.readonly'])];
    const destination = resolve(output, gym); await mkdir(destination, { recursive: true });
    await writeFile(resolve(destination, 'appsscript.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    result.push({ gym, account: 'revbjjops@gmail.com', addedScope: 'https://www.googleapis.com/auth/gmail.readonly', manifest: resolve(destination, 'appsscript.json'), consentGranted: false });
  }
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Use a new local output directory. This does not grant access.');
  console.log(JSON.stringify(await prepareReplyConsent(process.cwd(), resolve(process.argv[2])), null, 2));
}
