'use strict';

const VERSION = 1;

function isBattery(record) {
  if (/电池/.test(record?.award_name || '')) return true;
  const awards = record?.awards || record?.raw?.awards;
  return Array.isArray(awards) && awards.some(award => /电池/.test(award?.gift_name || ''));
}

function hasSpecialRequirement(record) {
  // 0: no extra requirement, 1: follow, 2: ordinary fan club. Other explicit
  // values are special/unknown, including 3 (the observed special gate).
  // Old summaries may omit this field; never let them mask a raw restriction.
  for (const source of [record, record?.raw]) {
    const value = source?.join_requirement;
    if (value == null) continue;
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2) continue;
    if (typeof value === 'string' && /^[012]$/.test(value.trim())) continue;
    return true;
  }
  return false;
}

function isExcludedBattery(record) {
  return isBattery(record) && hasSpecialRequirement(record);
}

module.exports = { VERSION, isBattery, hasSpecialRequirement, isExcludedBattery };
