import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';

const source = readFileSync(new URL('../integrations/google-apps-script/GibM1AttendanceDigest.gs', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const publicKey = 'public-m1-digest-vector-v1';

function run(defaultEncoding = 'utf8', explicitEncoding = 'utf8') {
  const calls = [], logs = [];
  const context = vm.createContext({
    console: { log: value => logs.push(value) },
    Utilities: {
      Charset: { UTF_8: 'UTF-8' },
      computeHmacSha256Signature(value, key, charset) {
        assert.equal(key, publicKey, 'the editor proof may only use its public vector key');
        assert.ok(charset === undefined || charset === 'UTF-8');
        calls.push({ value, key, charset });
        return [...createHmac('sha256', Buffer.from(key, charset ? explicitEncoding : defaultEncoding))
          .update(value, charset ? explicitEncoding : defaultEncoding).digest()].map(byte => byte > 127 ? byte - 256 : byte);
      }
    }
    // No PropertiesService, Sheets, locks, receiver secrets or UrlFetch exist.
  });
  vm.runInContext(source, context);
  return { result: plain(context.testRevolutionAttendanceDigestHmacVectors()), calls, logs };
}

test('public editor vectors independently match Node UTF-8 and require no private APIs', () => {
  const { result, calls, logs } = run();
  assert.deepEqual(result, { schema: 'm1-digest-public-hmac-vectors/v1', cases: [
    { id: 'ascii', defaultMatchesUtf8: true, defaultMatchesExpected: true, utf8MatchesExpected: true },
    { id: 'unicode', defaultMatchesUtf8: true, defaultMatchesExpected: true, utf8MatchesExpected: true }
  ] });
  assert.equal(calls.length, 4);
  for (let index = 0; index < calls.length; index += 2) {
    assert.equal(calls[index].value, calls[index + 1].value);
    assert.equal(calls[index].charset, undefined);
    assert.equal(calls[index + 1].charset, 'UTF-8');
  }
  assert.match(calls[2].value, /\u2014/);
  assert.match(calls[2].value, /\ud83e\udd4b/u);
  assert.deepEqual(logs, ['M1_TEST_DIGEST_HMAC_VECTORS ' + JSON.stringify(result)]);
  assert.equal(logs[0].includes(publicKey), false, 'only vector IDs and comparisons are reported');
});

test('the editor proof exposes a differing default encoding and dispatch pins explicit UTF-8', () => {
  const { result } = run('latin1');
  assert.deepEqual(result.cases[0], { id: 'ascii', defaultMatchesUtf8: true, defaultMatchesExpected: true, utf8MatchesExpected: true });
  assert.deepEqual(result.cases[1], { id: 'unicode', defaultMatchesUtf8: false, defaultMatchesExpected: false, utf8MatchesExpected: true });
  assert.match(source, /computeHmacSha256Signature\(GIB_M1_DIGEST_SCHEMA_ \+ '\\n' \+ raw, configuredAdminActionSecret_\(\), Utilities\.Charset\.UTF_8\)/,
    'the hosted public-vector result requires an explicit UTF-8 signature');
});

test('matching implementations cannot hide disagreement with the independent public oracle', () => {
  const { result } = run('latin1', 'latin1');
  assert.deepEqual(result.cases[1], { id: 'unicode', defaultMatchesUtf8: true, defaultMatchesExpected: false, utf8MatchesExpected: false });
});
