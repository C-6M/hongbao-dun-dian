'use strict';
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', 'data', 'qq-forward-settings.json');
const GROUP_ID = '1127875934';
const GROUP_NAME = '莓来-推送群';
const DEFAULTS = Object.freeze({ enabled: false, minPerPerson: null });

function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.enabled !== 'boolean' || Object.keys(value).some(k => !['enabled', 'minPerPerson'].includes(k))) {
    throw new Error('QQ 推送设置只接受 enabled 开关和 minPerPerson 人均门槛');
  }
  const settings = { enabled: value.enabled };
  if (Object.hasOwn(value, 'minPerPerson')) {
    const minimum = value.minPerPerson;
    if (minimum !== null && (typeof minimum !== 'number' || !Number.isFinite(minimum) || minimum < 0 || minimum > 100000000)) {
      throw new Error('QQ 最低人均电池必须为 0～100000000 的数字，或 null 表示沿用桌面通知门槛');
    }
    settings.minPerPerson = minimum;
  }
  return settings;
}
function readSettings(file = FILE, io = fs) {
  try { return { ...DEFAULTS, ...validateSettings(JSON.parse(io.readFileSync(file, 'utf8'))) }; }
  catch (e) { if (e.code === 'ENOENT') return { ...DEFAULTS }; throw e; }
}
function writeSettings(value, file = FILE) {
  const patch = validateSettings(value);
  const settings = { ...patch, minPerPerson: Object.hasOwn(patch, 'minPerPerson')
    ? patch.minPerPerson : readSettings(file).minPerPerson };
  const temp = file + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(settings, null, 2) + '\n');
    fs.renameSync(temp, file);
  } catch (e) { try { fs.unlinkSync(temp); } catch {} throw e; }
  return settings;
}
module.exports = { FILE, GROUP_ID, GROUP_NAME, DEFAULTS,
  validateSettings, readSettings, writeSettings };
