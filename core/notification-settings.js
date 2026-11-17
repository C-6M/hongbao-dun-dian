'use strict';
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'notification-settings.json');
const DEFAULTS = Object.freeze({ enabled: process.platform === 'win32',
  minPerPerson: 10, minBattery: 0, minRemainingSeconds: 0 });

function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('通知设置必须是对象');
  if (typeof value.enabled !== 'boolean') throw new Error('通知开关必须是开启或关闭');
  const result = { enabled: value.enabled };
  for (const [key, label, maximum, integer] of [
    ['minPerPerson', '最低人均电池', 100000000, false],
    ['minBattery', '最低总电池', 100000000, false],
    ['minRemainingSeconds', '最少剩余秒数', 86400, true],
  ]) {
    const n = value[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > maximum || (integer && !Number.isInteger(n))) {
      throw new Error(label + '必须是 0～' + maximum + ' 的' + (integer ? '整数' : '数字'));
    }
    result[key] = n;
  }
  if (Object.keys(value).some(key => !Object.hasOwn(DEFAULTS, key))) throw new Error('通知设置包含未知字段');
  return result;
}

function readSettings(file = FILE, io = fs) {
  try { return validateSettings(JSON.parse(io.readFileSync(file, 'utf8'))); }
  catch (e) { if (e.code === 'ENOENT') return { ...DEFAULTS }; throw e; }
}

function writeSettings(value, file = FILE) {
  const settings = validateSettings(value);
  const temp = file + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(settings, null, 2) + '\n');
    fs.renameSync(temp, file);
  } catch (e) {
    try { fs.unlinkSync(temp); } catch {}
    throw e;
  }
  return settings;
}

module.exports = { FILE, DEFAULTS, validateSettings, readSettings, writeSettings };
