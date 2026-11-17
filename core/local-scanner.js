'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const dataDir = path.join(__dirname, '..', 'data');

async function runLocalScanner({ args = [], env = process.env,
  entry = path.join(__dirname, 'spider.js'), stateFile = path.join(dataDir, 'live-state.json'),
  lockFile = path.join(dataDir, 'scanner.lock'), signal, stdio = 'inherit' } = {}) {
  let budget = env.SCANNER_PER_IP_BUDGET || '130';
  const bounded = args.some(arg => ['--once', '--rounds', '--stop'].includes(arg));
  while (!signal?.aborted) {
    const launchedAt = Date.now();
    const child = spawn(process.execPath, [entry, ...args], { windowsHide: true, stdio,
      env: { ...env, SCANNER_NODE_LIMIT: env.SCANNER_NODE_LIMIT || '12',
        SCANNER_IP_NETWORK_RETRY: env.SCANNER_IP_NETWORK_RETRY || '1',
        SCANNER_PER_IP_BUDGET: budget, SCANNER_STOP_ON_BAN: '1' } });
    let stopTimer;
    const requestStop = () => {
      try {
        const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        if (lock.pid !== child.pid) return;
        const target = lockFile + '.stop';
        if (fs.existsSync(target)) return;
        const temp = target + '.' + process.pid + '.tmp';
        fs.writeFileSync(temp, JSON.stringify({ pid: child.pid }));
        fs.renameSync(temp, target);
      } catch (error) {
        if (error.code !== 'ENOENT') console.error('[本机启动] 无法请求保存退出: ' + error.message);
      }
    };
    const stop = () => {
      if (stopTimer) return;
      requestStop();
      stopTimer = setInterval(requestStop, 250);
    };
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    let exitCode;
    try {
      exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', code => resolve(code ?? 1));
      });
    } finally {
      clearInterval(stopTimer);
      signal?.removeEventListener('abort', stop);
    }
    let state;
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
    const banned = state?.pid === child.pid && state.started >= launchedAt && state.stats?.banned > 0;
    if (signal?.aborted || bounded || !banned) return exitCode;
    if (Number(budget) <= 110) {
      console.error('[本机启动] 110 预算仍出现风控，已停止扫描。');
      return 1;
    }
    if (state.storage?.error) throw new Error('存储异常，无法回退重启: ' + state.storage.error);
    budget = '110';
    console.log('[本机启动] 首次风控已保存退出，本次运行回退到 110，保留出口冷却记录。');
  }
  return 0;
}

if (require.main === module) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  runLocalScanner({ args: process.argv.slice(2), signal: controller.signal })
    .then(code => { process.exitCode = code; })
    .catch(error => { console.error('[本机启动] ' + error.message); process.exitCode = 1; })
    .finally(() => {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    });
}

module.exports = { runLocalScanner };
