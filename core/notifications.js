'use strict';
const path = require('path');
const { execFile } = require('child_process');
const { DEFAULTS } = require('./notification-settings');
const { isExcludedBattery } = require('./redpocket-policy');

function buildNotification(record, time = Date.now(), settings = DEFAULTS) {
  // Retain the numeric argument for existing callers that supply only a per-person threshold.
  const rules = typeof settings === 'number' ? { ...DEFAULTS, enabled: true, minPerPerson: settings } : settings;
  if (!record || !rules.enabled) return null;
  const battery = Number(record.battery);
  const people = Number(record.award_num);
  const expiresAt = Number(record.end_time) * 1000;
  const room = String(record.room_id || '');
  const id = String(record.lid || '');
  if (!/电池/.test(record.award_name || '') || record.expired || isExcludedBattery(record)
    || !Number.isFinite(battery) || battery <= 0
    || !Number.isInteger(people) || people <= 0
    || !Number.isFinite(expiresAt) || expiresAt <= time
    || !/^\d+$/.test(room) || !/^\d+$/.test(id)
    || battery / people < rules.minPerPerson || battery < rules.minBattery
    || expiresAt - time < rules.minRemainingSeconds * 1000) return null;
  const format = value => Number(value.toFixed(2)).toString();
  const remaining = Math.ceil((expiresAt - time) / 1000);
  return {
    id, room, expiresAt,
    title: '红包蹲点 · 人均 ' + format(battery / people) + ' 电池',
    body: format(battery) + ' 电池 / ' + people + ' 人\n房间 ' + room
      + ' · 剩余 ' + Math.floor(remaining / 60) + '分' + remaining % 60 + '秒',
    url: 'https://live.bilibili.com/' + room,
    button: '打开直播间',
  };
}

function sendDesktop(payload) {
  if (process.platform !== 'win32') return Promise.reject(new Error('桌面提醒需要 Windows'));
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    const child = execFile(executable, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
      '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'notify-windows.ps1')],
    { windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 128 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error((stderr || error.message).trim().slice(0, 500)));
      try {
        const result = JSON.parse(stdout.trim());
        if (!result.submitted) throw new Error('Windows 未确认通知提交');
        resolve(result);
      } catch (e) { reject(e); }
    });
    child.stdin.on('error', reject);
    // JSON is data on stdin, never part of a PowerShell command or XML source.
    child.stdin.end(JSON.stringify(payload));
  });
}

module.exports = { buildNotification, sendDesktop };

if (require.main === module && process.argv.includes('--test')) {
  const payload = { id: 'notification-test', title: '红包蹲点 · 测试通知',
    body: '100 电池 / 10 人，人均 10 电池\n提醒功能测试，不是真实红包。',
    url: 'http://127.0.0.1:8443/pool', button: '打开看板', expiresAt: Date.now() + 120000 };
  sendDesktop(payload).then(result => console.log(JSON.stringify(result)))
    .catch(e => { console.error(e.message); process.exitCode = 1; });
}
