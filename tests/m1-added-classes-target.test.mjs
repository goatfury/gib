import assert from 'node:assert/strict';
import test from 'node:test';
import core from '../m1/temporary-classes-core.js';
import { installationProfile } from '../m1/installation-profile-core.mjs';

const rev = installationProfile('rev');
const richTest = installationProfile('richmond', 'test');
const richProduction = installationProfile('richmond', 'production', 'active');
const immutable = '0123456789abcdef01234567';

test('added-class target is derived from the canonical gym profile and actual HTTPS host', () => {
  for (const [profile, host, target] of [
    [rev, 'gib-live.netlify.app', 'production'],
    [rev, 'deploy-preview-83--gib-live.netlify.app', 'test'],
    [rev, `${immutable}--gib-live.netlify.app`, 'test'],
    [richTest, 'gib-richmond-test.netlify.app', 'test'],
    [richTest, `${immutable}--gib-richmond-test.netlify.app`, 'test'],
    [richProduction, 'gib-richmond-live.netlify.app', 'production']
  ]) {
    assert.equal(core.resolveAddedClassesTarget(profile, `https://${host}/m1/admin/?task=class#add-class`), target);
  }
});

test('unknown, cross-gym, cross-environment and noncanonical production hosts have no added-class target', () => {
  for (const [profile, href] of [
    [rev, 'http://gib-live.netlify.app/m1/'],
    [rev, 'https://gib-live.netlify.app:8443/m1/'],
    [rev, 'https://user:password@gib-live.netlify.app/m1/'],
    [rev, 'https://gib-live.netlify.app.foreign.example/m1/'],
    [rev, 'https://bjjsite.com/m1/'],
    [rev, 'https://branch--gib-live.netlify.app/m1/'],
    [rev, 'https://gib-richmond-live.netlify.app/m1/'],
    [richTest, 'https://gib-richmond-live.netlify.app/m1/'],
    [richProduction, 'https://gib-richmond-test.netlify.app/m1/'],
    [richProduction, `https://${immutable}--gib-richmond-live.netlify.app/m1/`],
    [{ installationId: 'richmond' }, 'https://gib-richmond-test.netlify.app/m1/'],
    [{ installationId: 'other' }, 'https://gib-live.netlify.app/m1/'],
    [null, 'https://gib-live.netlify.app/m1/'],
    [rev, undefined]
  ]) assert.equal(core.resolveAddedClassesTarget(profile, href), '', String(href));
});

test('same-gym documents still require the independently derived expected target', () => {
  for (const gymId of ['rev', 'richmond']) {
    for (const target of ['test', 'production']) {
      const document = { ok: true, schema: core.SCHEMA, gymId, target, timezone: core.TIME_ZONE,
        version: 0, updatedAt: null, servedAt: '2026-09-08T12:00:00Z', current: true,
        series: [], history: [], importedIdentities: [] };
      assert.equal(core.validateDocument(document, gymId, target), document);
      assert.equal(core.validateDocument(document, gymId, target === 'test' ? 'production' : 'test'), null);
      assert.equal(core.validateDocument(document, gymId === 'rev' ? 'richmond' : 'rev', target), null);
      for (const invalid of ['', 'unknown', null, true]) assert.equal(core.validateDocument(document, gymId, invalid), null);
      assert.equal(core.validateDocument(document, gymId), target === 'test' ? document : null,
        'Existing TEST callers retain a fail-closed default; production must be explicit');
    }
  }
});
