'use strict';
const fs = require('node:fs');
const path = require('node:path');
const roomBlocklist = require('./room-blocklist');
const FILE = path.join(__dirname, '..', 'data', 'qq-push-blocklist.json');
const validateSettings = roomBlocklist.validateSettings;
const readSettings = (file = FILE, io = fs) => roomBlocklist.readSettings(file, io);
function writeSettings(value, file = FILE, io = fs,
  pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)) {
  const settings = validateSettings(value), temp = file + '.' + process.pid + '.tmp';
  try {
    io.writeFileSync(temp, JSON.stringify(settings, null, 2) + '\n');
    for (let attempt = 0; ; attempt++) {
      try { io.renameSync(temp, file); return settings; }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 10) throw error;
        pause(50);
      }
    }
  } catch (error) { try { io.unlinkSync(temp); } catch {} throw error; }
}
module.exports = { FILE, validateSettings, readSettings, writeSettings };
