import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const adminHtml = readFileSync(new URL('../m1/admin/index.html', import.meta.url), 'utf8')
  .replace(/\r\n?/gu, '\n');

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `Missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

function openingTag(id) {
  const match = adminHtml.match(new RegExp(`<[^>]+\\bid="${id}"[^>]*>`, 'u'));
  assert.ok(match, `Missing opening tag for #${id}`);
  return match[0];
}

test('Admin exposes exactly two top-level modes and keeps secondary tools under More', () => {
  const navigation = sourceBetween(adminHtml, '<nav id="managerModes"', '</nav>');
  assert.equal((navigation.match(/\brole="tab"/gu) || []).length, 2);
  assert.match(navigation, /href="#sign-ins"[\s\S]*>Daily sign-ins</u);
  assert.match(navigation, /href="#staff-time"[\s\S]*>Staff Clock</u);
  assert.doesNotMatch(navigation, /Dashboard|Home|Overview/iu);

  const header = sourceBetween(adminHtml, '<header class="topbar">', '</header>');
  assert.match(header, /<h1 id="appHeading">M1 Admin<\/h1>/u);
  assert.match(header, />Instructor Sign-In<\/a>/u);
  assert.match(header, />Log Out<\/button>/u);
  assert.match(header, /<details id="adminMore"[\s\S]*Local M1 Admin[\s\S]*tabletDiagnosticButton/u);
  assert.doesNotMatch(openingTag('adminMore'), /\bopen\b/u);
});

test('Daily sign-ins is the default and the two deep links select one panel at a time', () => {
  const source = sourceBetween(adminHtml, 'function requestedManagerMode()', 'function setLoggedOut(');
  const nodes = Object.fromEntries([
    '#sign-ins', '#staff-time', '#dailyModeControl', '#staffModeControl', '#appPanel'
  ].map(selector => [selector, {
    hidden: selector === '#appPanel' ? false : undefined,
    tabIndex: 0,
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = String(value); },
    focus() { this.focused = true; }
  }]));
  const context = vm.createContext({ nodes });
  new vm.Script(`
    const STAFF_CLOCK_ENABLED = true;
    const location = { hash: '' };
    const window = { requestAnimationFrame(callback) { callback(); } };
    function $(selector) { return nodes[selector]; }
    ${source}
    globalThis.hooks = {
      requestedManagerMode,
      applyManagerMode,
      setHash(value) { location.hash = value; }
    };
  `).runInContext(context);

  assert.equal(context.hooks.requestedManagerMode(), 'sign-ins');
  context.hooks.applyManagerMode();
  assert.equal(nodes['#sign-ins'].hidden, false);
  assert.equal(nodes['#staff-time'].hidden, true);
  assert.equal(nodes['#dailyModeControl'].attributes['aria-selected'], 'true');

  context.hooks.setHash('#staff-time');
  assert.equal(context.hooks.requestedManagerMode(), 'staff-time');
  context.hooks.applyManagerMode({ focus: true });
  assert.equal(nodes['#sign-ins'].hidden, true);
  assert.equal(nodes['#staff-time'].hidden, false);
  assert.equal(nodes['#staffModeControl'].attributes['aria-selected'], 'true');
  assert.equal(nodes['#staff-time'].focused, true);

  context.hooks.setHash('#sign-ins');
  context.hooks.applyManagerMode();
  assert.equal(nodes['#sign-ins'].hidden, false);
  assert.equal(nodes['#staff-time'].hidden, true);
});

test('Daily review is decision-first: counts, missing rows, then collapsed completed rows', () => {
  const daily = sourceBetween(adminHtml, '<section id="sign-ins"', '<section id="staff-time"');
  const scheduled = daily.indexOf('id="dailyScheduledCount"');
  const signed = daily.indexOf('id="dailySignedCount"');
  const missingCount = daily.indexOf('id="dailyMissingCount"');
  const missingRows = daily.indexOf('id="classList"');
  const completed = daily.indexOf('id="completedClasses"');
  assert.ok(scheduled >= 0 && signed > scheduled && missingCount > signed);
  assert.ok(missingRows > missingCount && completed > missingRows);
  assert.match(daily, /Missing scheduled classes/u);
  assert.match(
    sourceBetween(adminHtml, 'function classRow(', 'function renderReview('),
    /Add forgotten instructor/u
  );
  assert.match(daily, /Show completed classes/u);
  assert.doesNotMatch(openingTag('completedClasses'), /\bopen\b/u);

  const render = sourceBetween(adminHtml, 'function renderReview()', 'async function loadReview(');
  assert.match(render, /missingRows = scheduled\.filter\(item => item\.matches\.length === 0\)/u);
  assert.match(render, /completedRows = scheduled\.filter\(item => item\.matches\.length > 0\)/u);
  assert.ok(render.indexOf("$('#classList')") < render.indexOf("$('#completedClassList')"));
});

test('Staff Clock prioritizes attention and keeps every heavy workflow closed', () => {
  const staff = sourceBetween(adminHtml, '<section id="staff-time"', '</section>\n    </section>');
  const attention = staff.indexOf('id="staffNeedsAttentionSection"');
  const clockedIn = staff.indexOf('id="staffClockedInNow"');
  const recent = staff.indexOf('id="staffRecentShifts"');
  const older = staff.indexOf('id="staffOlderShiftFinder"');
  const pay = staff.indexOf('id="staffPayPeriods"');
  const advanced = staff.indexOf('id="staffTimeAdvanced"');
  assert.ok(attention >= 0 && clockedIn > attention && recent > clockedIn);
  assert.ok(older > recent && pay > older && advanced > pay);

  assert.match(openingTag('staffCorrectionPanel'), /\bhidden\b/u);
  assert.match(adminHtml, /id="staffCorrectionOpen"[^>]*aria-expanded="false"[^>]*>Add missed punch/u);
  for (const id of ['staffOlderShiftFinder', 'staffPayPeriods', 'staffTimeAdvanced']) {
    assert.doesNotMatch(openingTag(id), /\bopen\b/u, `${id} must start closed`);
  }
  const advancedMarkup = sourceBetween(adminHtml, '<details id="staffTimeAdvanced"', '</details>');
  assert.match(advancedMarkup, /Today’s punches[\s\S]*Staff Time records[\s\S]*Staff time audit/u);
  assert.doesNotMatch(advancedMarkup, /Needs attention/u);
});

test('recent shifts start at eight, show complete shift facts, and expand only on request', () => {
  assert.match(adminHtml, /const STAFF_RECENT_INITIAL_LIMIT = 8;/u);
  assert.match(adminHtml, /staffRecentVisibleLimit = STAFF_RECENT_INITIAL_LIMIT/u);
  assert.match(adminHtml, /lookup\.items\.slice\(0, staffRecentVisibleLimit\)/u);
  assert.match(adminHtml, /id="staffRecentShowMore"[^>]*hidden[^>]*>Show more recent shifts/u);
  assert.match(adminHtml, /STAFF_RECENT_MAX_VISIBLE = 20/u);
  assert.match(
    adminHtml,
    /Clock-in \$\{staffTimestampLabel\(shift\.clockIn\.timestamp\)\} · Clock-out \$\{staffTimestampLabel\(shift\.clockOut\.timestamp\)\} · Duration \$\{staffShiftDurationLabel\(shift\)\}/u
  );
  assert.match(adminHtml, /row\.appendChild\(staffAdjustmentForm\(shift\)\)/u);
});

test('manager workflow has explicit asynchronous states and no nested scroll container', () => {
  for (const text of [
    'Loading Daily sign-ins',
    'Daily sign-ins could not be loaded',
    'Retry Daily sign-ins',
    'Every scheduled class has a recorded instructor sign-in',
    'Instructor sign-ins loaded',
    'Loading Staff Clock attention',
    'No Staff Clock issues need attention',
    'Retry Staff Clock',
    'Loading recent completed shifts',
    'No completed shifts in the last seven days',
    'Retry recent completed shifts',
    'No completed shifts found',
    'Retry advanced records and audit',
    'Advanced records and audit loaded'
  ]) assert.match(adminHtml, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));

  const styles = sourceBetween(adminHtml, '<style>', '</style>');
  assert.doesNotMatch(styles, /overflow-y\s*:\s*(?:auto|scroll)/iu);
  assert.doesNotMatch(styles, /overflow\s*:\s*(?:auto|scroll)/iu);
  assert.doesNotMatch(styles, /#staffRecentShifts[\s\S]{0,160}(?:max-height|overflow)/u);
});

test('mode controls support keyboard and Fire-sized touch interaction', () => {
  assert.match(adminHtml, /id="managerModes"[^>]*role="tablist"/u);
  assert.match(adminHtml, /\['ArrowLeft', 'ArrowRight', 'Home', 'End'\]\.includes\(event\.key\)/u);
  assert.match(adminHtml, /controls\[next\]\.focus\(\)/u);
  assert.match(adminHtml, /location\.hash = controls\[next\]\.getAttribute\('href'\)/u);
  assert.match(adminHtml, /\.btn\s*\{[\s\S]*min-height:\s*44px/u);
  assert.match(adminHtml, /\.mode-control\s*\{[\s\S]*min-height:\s*44px/u);
  assert.match(adminHtml, /summary:focus-visible/u);
  assert.match(openingTag('sign-ins'), /role="tabpanel"[\s\S]*tabindex="-1"/u);
  assert.match(openingTag('staff-time'), /role="tabpanel"[\s\S]*tabindex="-1"/u);
});

test('Richmond hides the Staff Clock mode and panel through the installation profile', () => {
  assert.match(adminHtml, /const STAFF_CLOCK_ENABLED = INSTALLATION\.featureFlags\.staffClock === true;/u);
  assert.match(adminHtml, /\$\('#staffModeControl'\)\.hidden = !STAFF_CLOCK_ENABLED;/u);
  assert.match(adminHtml, /\$\('#staff-time'\)\.hidden = true;/u);
  const modeSource = sourceBetween(adminHtml, 'function requestedManagerMode()', 'function setLoggedOut(');
  assert.match(modeSource, /staff\.hidden = !staffActive \|\| !STAFF_CLOCK_ENABLED/u);

  const staffPanel = sourceBetween(adminHtml, '<section id="staff-time"', '<div id="toast"');
  assert.match(staffPanel, /id="staffOlderShiftDate"/u, 'the date finder remains inside the hidden Staff Clock panel');
  const nodes = Object.fromEntries([
    '#sign-ins', '#staff-time', '#dailyModeControl', '#staffModeControl', '#appPanel'
  ].map(selector => [selector, {
    hidden: false,
    tabIndex: 0,
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = String(value); },
    focus() { this.focused = true; }
  }]));
  const context = vm.createContext({ nodes });
  new vm.Script(`
    const STAFF_CLOCK_ENABLED = false;
    const location = { hash: '#staff-time' };
    const window = { requestAnimationFrame(callback) { callback(); } };
    function $(selector) { return nodes[selector]; }
    ${modeSource}
    globalThis.hooks = { requestedManagerMode, applyManagerMode };
  `).runInContext(context);
  assert.equal(context.hooks.requestedManagerMode(), 'sign-ins');
  context.hooks.applyManagerMode();
  assert.equal(nodes['#sign-ins'].hidden, false);
  assert.equal(nodes['#staff-time'].hidden, true);
});
