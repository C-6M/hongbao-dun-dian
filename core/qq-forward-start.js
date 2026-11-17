'use strict';
// Run from the user's normal desktop launcher. Do not change Windows integrity labels.
const { buildSender } = require('./build-qq-sender');
const { startWorker } = require('./qq-forward-worker');
try {
  const official = require('./qq-bot-config').read().active;
  const file = official ? '' : buildSender();
  require('./qq-forward-settings').writeSettings({ enabled: true });
  startWorker();
  console.log('QQ 自动推送已开启：1127875934（莓来-推送群）');
  console.log(official ? '使用 QQ 官方机器人，无需打开 QQ 群窗口。' : '发送组件：' + file);
  console.log('按 QQ 人均门槛和已有总额、剩余时间条件推送，桌面通知开关不影响 QQ 推送。');
} catch (error) {
  console.error(error.stdout || error.stderr || error.message);
  process.exitCode = 1;
}
