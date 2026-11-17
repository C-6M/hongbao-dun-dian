'use strict';
const fs = require('node:fs');
const path = require('node:path');
const FILE = path.join(__dirname, '..', 'data', 'room-blocklist.json');

function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Array.isArray(value.rooms) || Object.keys(value).some(key => key !== 'rooms')) {
    throw new Error('房间屏蔽设置只接受 rooms 数组');
  }
  const rooms = value.rooms.map(room => {
    if (!['string', 'number'].includes(typeof room) || !/^\d{1,12}$/.test(String(room)) || Number(room) === 0) {
      throw new Error('屏蔽房间号必须是有效的数字房间号');
    }
    return String(Number(room));
  });
  return { rooms: [...new Set(rooms)] };
}

function readSettings(file = FILE, io = fs) {
  try { return validateSettings(JSON.parse(io.readFileSync(file, 'utf8'))); }
  catch (e) { if (e.code === 'ENOENT') return { rooms: [] }; throw e; }
}

module.exports = { FILE, validateSettings, readSettings };
