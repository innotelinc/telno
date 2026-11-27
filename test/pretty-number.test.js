/**
 * A caller ID must not lose its country code.
 *
 * The softphone shows the caller with this fallback formatter, and the switch
 * hands it the CallerID as it arrived — for an inbound DID that is the bare
 * national number, `4132642700`. Guessing the country from the leading digits
 * alone reads that as +41 (Switzerland), so a Massachusetts caller ID appeared
 * as "+41 326 427 00": the number on screen belonged to another country.
 *
 * A ten-digit number with no `+` is only complete without a country code in the
 * North American Numbering Plan, which is this platform's default region.
 *
 *   npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { prettyNumber } = await import('../web/src/api.js');

test('a bare North American number keeps +1 instead of inventing a country', () => {
  assert.equal(prettyNumber('4132642700'), '+1 (413) 264-2700');
  // The same number with the country code still reads the same way.
  assert.equal(prettyNumber('14132642700'), '+1 (413) 264-2700');
  assert.equal(prettyNumber('+14132642700'), '+1 (413) 264-2700');
});

test('a number that states its country keeps it', () => {
  // Only the dial code matters here; the grouping of the rest is cosmetic.
  assert.ok(prettyNumber('+442071838750').startsWith('+44 '), prettyNumber('+442071838750'));
  assert.ok(prettyNumber('+41326427000').startsWith('+41 '), prettyNumber('+41326427000'));
});

test('extensions and short values are left alone', () => {
  assert.equal(prettyNumber('101'), '101');
  assert.equal(prettyNumber(''), '');
  assert.equal(prettyNumber(undefined), '');
});
