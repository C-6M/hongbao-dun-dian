'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../core/redpocket-policy');

test('ordinary follow and fan-club gates remain eligible in raw responses and saved summaries', () => {
  for (const join_requirement of [undefined, null, 0, 1, 2, '0', '1', '2']) {
    const raw = { awards: [{ gift_name: '电池红包', num: 10 }], join_requirement };
    assert.equal(policy.isExcludedBattery(raw), false);
    assert.equal(policy.isExcludedBattery({ award_name: '电池红包', join_requirement }), false);
  }
});

test('explicit special, new or malformed gates never become unrestricted by coercion', () => {
  for (const join_requirement of [3, '3', 4, '99', -1, 1.5, '', '大航海', true, {}, []]) {
    const raw = { awards: [{ gift_name: '电池红包' }], join_requirement };
    assert.equal(policy.isExcludedBattery(raw), true);
    assert.equal(policy.isExcludedBattery({ award_name: '电池红包', join_requirement: 0, raw }), true);
  }
});

test('the battery filter does not remove unrelated reward types', () => {
  assert.equal(policy.isExcludedBattery({ award_name: '亲密度红包', join_requirement: 3 }), false);
  assert.equal(policy.isExcludedBattery(null), false);
});
