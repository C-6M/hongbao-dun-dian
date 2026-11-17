#!/usr/bin/env node
'use strict';
// Running scanners merge QQ exports themselves; offline imports hold the scanner lock.
const fs = require('fs');
const path = require('path');
const { mergeQQ } = require('./strategy');
const dir = path.join(__dirname, '..', 'data');
const source = path.join(dir, 'qq_redpacket_extract.json');
const destination = path.join(dir, 'room-pool.json');
const lockFile = path.join(dir, 'scanner.lock');

function main() {
  const data = JSON.parse(fs.readFileSync(source, 'utf8'));
  try {
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    let alive = true;
    try { process.kill(lock.pid, 0); } catch (e) { alive = e.code !== 'ESRCH'; }
    if (alive) {
      console.log('扫描器正在运行，QQ 文件会在下一轮自动同步（' + (data.rooms || []).length + ' 个房间）。');
      return;
    }
    fs.unlinkSync(lockFile);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  // An older scanner has no lock file. Do not compete with its in-memory pool.
  try {
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'live-state.json'), 'utf8'));
    if (state.schemaVersion !== 2 && state.phase !== 'stopped' && Date.now() - state.updated < 60000) {
      console.log('旧版扫描器仍在运行；重启新版后会自动接入 QQ 房间。');
      return;
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, purpose: 'qq-import' }), { flag: 'wx' });
  const temp = destination + '.' + process.pid + '.tmp';
  try {
    let saved = { rooms: {} };
    try { saved = JSON.parse(fs.readFileSync(destination, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const pool = new Map(Object.entries(saved.rooms || {}));
    const result = mergeQQ(pool, data, Date.now());
    fs.writeFileSync(temp, JSON.stringify({ ...saved, at: new Date().toISOString(), rooms: Object.fromEntries(pool) }));
    fs.renameSync(temp, destination);
    console.log('QQ 接入 ' + result.updated + ' 个房间，新增 ' + result.added + '；使用实际推送时间评分。');
  } finally {
    try { fs.unlinkSync(temp); } catch {}
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    if (lock.pid === process.pid) fs.unlinkSync(lockFile);
  }
}

if (require.main === module) main();
