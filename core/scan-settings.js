'use strict';
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', 'data', 'scan-settings.json');
const DEFAULTS = Object.freeze({ enabled: true });

function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.enabled !== 'boolean' || Object.keys(value).some(key => key !== 'enabled')) {
    throw new Error('扫描设置只接受 enabled 布尔开关');
  }
  return { enabled: value.enabled };
}

function readSettings(file = FILE, io = fs) {
  try { return validateSettings(JSON.parse(io.readFileSync(file, 'utf8'))); }
  catch (e) { if (e.code === 'ENOENT') return { ...DEFAULTS }; throw e; }
}

function writeSettings(value, file = FILE) {
  const settings = validateSettings(value);
  const temp = file + '.' + process.pid + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
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
