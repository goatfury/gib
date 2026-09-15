import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Guard the authored stylesheet against the acceptance thresholds. Mounted
// browser QA separately checks computed cascade, practical reading and layout.
const css = readFileSync(new URL('../m1/promotions.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../m1/index.html', import.meta.url), 'utf8');
const rules = [...css.replace(/\/\*[\s\S]*?\*\//gu, '').matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
  .filter(match => !match[1].trim().startsWith('@'))
  .map(match => ({ selector:match[1].trim(), values:Object.fromEntries(match[2].split(';').filter(value => value.includes(':')).map(value => { const colon = value.indexOf(':'); return [value.slice(0,colon).trim(), value.slice(colon + 1).trim()]; })) }));
const values = selector => rules.find(rule => rule.selector === selector)?.values || {};
function luminance(hex) {
  assert.match(hex, /^#[\da-f]{6}$/iu);
  const rgb = hex.slice(1).match(/../gu).map(value => parseInt(value,16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function contrast(text, background) {
  const a = luminance(text), b = luminance(background);
  return (Math.max(a,b) + 0.05) / (Math.min(a,b) + 0.05);
}

test('promotion text, helper/empty states, placeholders, selected results, disabled controls and notices meet 4.5:1', () => {
  const root = values('.m1-promotions');
  const helper = values('.m1-promotions .muted,.m1-promotions .hint,.m1-promotions .identity').color;
  const placeholder = values('.m1-promotions input::placeholder,.m1-promotions textarea::placeholder');
  const surfaces = [root.background, values('.m1-promotions .card').background, values('.m1-promotions .search-option[aria-selected="true"]').background, values('.m1-promotions button').background];
  for (const foreground of [root.color, helper, placeholder.color]) {
    for (const background of surfaces) assert.ok(contrast(foreground,background) >= 4.5, `${foreground} on ${background}`);
  }
  assert.equal(placeholder.opacity, '1', 'browser placeholder opacity must not reduce contrast');
  for (const selector of ['.m1-promotions button.primary', '.m1-promotions button:disabled', '.m1-promotions .badge', '.m1-promotions .notice', '.m1-promotions .notice.error', '.m1-promotions .notice.warning', '.m1-promotions .notice.success', '.promotions-log-entry']) {
    const style = values(selector);
    assert.ok(contrast(style.color,style.background) >= 4.5, selector);
  }
  const entry = values('.promotions-log-entry');
  assert.ok(contrast(entry.color,values('.promotions-log-entry:hover').background) >= 4.5);
  assert.ok(contrast(values('.promotions-log-entry:disabled').color,entry.background) >= 4.5);
});

test('promotion readability styles stay scoped and preserve one entry beneath Sign In', () => {
  for (const rule of rules) {
    const selector = rule.selector;
    assert.ok(selector.startsWith('.m1-promotions') || selector.startsWith('.promotions-') || selector.startsWith('#promotions') || selector === 'body.admin-mode .promotions-navigation' || selector === 'body.promotions-view #kiosk, body.promotions-view #staffClock', selector);
  }
  assert.equal((html.match(/id="openPromotionsLog"/gu) || []).length, 1);
  assert.ok(html.indexOf('id="btnSignIn"') < html.indexOf('id="openPromotionsLog"'));
  assert.ok(html.indexOf('id="openPromotionsLog"') < html.indexOf('id="staffClock"'));
  assert.match(values('.m1-promotions').font, /18px\//u);
  for (const selector of ['.m1-promotions label', '.m1-promotions .search-option strong']) assert.ok(parseInt(values(selector)['font-size'],10) >= 18, selector);
  for (const rule of rules) if (rule.values['font-size']) assert.ok(parseInt(rule.values['font-size'],10) >= 16, rule.selector);
  for (const selector of ['.promotions-log-entry', '.m1-promotions button,.m1-promotions input,.m1-promotions select', '.m1-promotions .search-option', '.m1-promotions .approver-results .search-option', '.m1-promotions summary']) assert.ok(parseInt(values(selector)['min-height'],10) >= 44, selector);
  assert.ok(parseInt(values('.m1-promotions .rank')['font-size'],10) >= 26);
  assert.match(values('.m1-promotions .search-option[aria-selected="true"]').outline, /2px solid/u);
  assert.match(values('.m1-promotions :is(button,input,select,textarea,summary):focus-visible').outline, /3px solid/u);
});
