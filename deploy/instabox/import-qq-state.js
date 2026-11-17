'use strict';
// Read private configuration on stdin. Never put credentials in command arguments or logs.
const fs = require('node:fs');
const path = require('node:path');
const config = require('../../core/qq-bot-config');
const { initialState } = require('../../core/qq-forward');
const { BotHistory } = require('../../core/qq-bot-history');
const notices = require('../../core/notification-settings');
const pushBlocks = require('../../core/qq-push-blocklist');
const FILES = ['qq-bot-config.json', 'qq-bot-history.json', 'qq-forward-state.json',
  'qq-anchor-names.json', 'qq-audience-uids.json', 'qq-push-blocklist.json', 'notification-settings.json'];
function importState(input, directory) {
  if (!input || input.version !== 1 || !input.files || Object.keys(input.files).some(f => !FILES.includes(f))
    || FILES.some(f => !input.files[f] || typeof input.files[f] !== 'object')) throw new Error('Invalid transfer');
  const values = input.files;
  const bot = config.validate(values['qq-bot-config.json']);
  if (!bot.active || !bot.appId || !bot.appSecret || !bot.groupOpenid) throw new Error('Bot not configured');
  const forwarding = values['qq-forward-state.json'];
  if (forwarding.enabled || !Array.isArray(forwarding.deliveries)
    || forwarding.deliveries.some(d => d.status === 'reserved')) throw new Error('Local forwarding still active');
  initialState(forwarding);
  const history = values['qq-bot-history.json'];
  new BotHistory({ saved: history, appId: bot.appId });
  if (history.appId !== bot.appId || history.groupOpenid !== bot.groupOpenid) throw new Error('Binding mismatch');
  notices.validateSettings(values['notification-settings.json']);
  pushBlocks.validateSettings(values['qq-push-blocklist.json']);
  const copied = { ...values, 'qq-forward-state.json': { ...forwarding, pid: 0, enabled: false },
    'qq-forward-settings.json': { enabled: false } };
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  for (const [file, value] of Object.entries(copied)) {
    const target = path.join(directory, file), temp = target + '.migration.tmp';
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(temp, 0o600); fs.renameSync(temp, target);
  }
  return { imported: true, files: Object.keys(copied).length, sentRecords: forwarding.sent,
    bindingPreserved: true, sendingEnabled: false };
}
module.exports = { importState, FILES };
if (require.main === module) {
  let input = '', bytes = 0;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', data => { bytes += Buffer.byteLength(data); if (bytes > 2 * 1024 * 1024) process.exit(1); input += data; });
  process.stdin.on('end', () => {
    try { console.log(JSON.stringify(importState(JSON.parse(input), '/data/hongbao/data'))); }
    catch { console.error('Private state import failed; details suppressed.'); process.exitCode = 1; }
  });
}
