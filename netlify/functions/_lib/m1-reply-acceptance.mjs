// CANDIDATE ONLY: requires independent review before inclusion in a release.
// The authenticated receiver supplies prepareReplyEvent; this module has no I/O.
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const fail = () => { throw Object.assign(new Error('REPLY_ACCEPTANCE_NOT_APPROVED'), { code: 'REPLY_ACCEPTANCE_NOT_APPROVED' }); };
export async function prepareReplyAcceptance(input, scope, env, now, prepareEvent) {
  const expectedKeys = ['schema','action','gym','target','requestId','createdAt','expiresAt','eventId'].sort().join(',');
  if (!input || Object.keys(input).sort().join(',') !== expectedKeys || input.schema !== 'm1-reply-intake/v1'
    || input.action !== 'prepare-acceptance' || input.target !== 'production' || scope?.target !== 'production'
    || !['rev','richmond'].includes(input.gym) || scope.profile?.installationId !== input.gym
    || !uuid(input.requestId) || !uuid(input.eventId) || input.eventId !== env.GIB_M1_REPLY_ACCEPTANCE_EVENT_ID
    || !Number.isSafeInteger(input.createdAt) || input.createdAt > now + 5000
    || input.expiresAt !== input.createdAt + 60000 || now >= input.expiresAt) fail();
  const start = Number(env.GIB_M1_REPLY_ACCEPTANCE_START_AT), until = Number(env.GIB_M1_REPLY_ACCEPTANCE_EXPIRES_AT);
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(start) || !Number.isSafeInteger(until)
    || start <= 0 || until <= start || until - start > 1800000 || now < start || now >= until
    || env.GIB_M1_REPLY_INTAKE_ENABLED !== 'true' || typeof prepareEvent !== 'function') fail();
  const gym = input.gym, label = gym === 'rev' ? 'Revolution' : 'Richmond';
  const subject = 'GiB reply intake TEST ONLY - ' + label;
  // Fixed lease start makes all transport retries byte-identical. No real rows,
  // instructors, daily digest claims, schedules, or payroll inputs are invented.
  const check = { testProvenance: 'gib-reply-acceptance/v1', binding: { requestId: input.eventId, jobDate: new Date(start).toISOString().slice(0,10), createdAt: start },
    digest: { groups: [{ gym, items: [] }] }, snapshots: [], schedules: [] };
  const report = await prepareEvent(check, scope, { rendered: { subject, text: '', html: '' } });
  const marked = subject + ' [GiB ' + gym + ' ' + input.eventId + ']';
  if (report?.rendered?.subject !== marked) fail();
  return { schema: 'm1-reply-acceptance/v1', gym, eventId: input.eventId, subject: marked,
    mailbox: 'revbjjops@gmail.com', manager: gym === 'rev' ? 'info@revolutionbjj.com' : 'info@richmondbjj.com', expiresAt: until };
}
