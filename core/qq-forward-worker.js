'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { Forwarder, buildCandidate, sameCandidate, refreshForward } = require('./qq-forward');
const settings = require('./qq-forward-settings');
const blocklist = require('./room-blocklist');
const pushBlocklist = require('./qq-push-blocklist');
const notificationSettings = require('./notification-settings');
const scanSettings = require('./scan-settings');
const botConfig = require('./qq-bot-config');
const { QQBotClient } = require('./qq-bot-client');
const { BotHistory } = require('./qq-bot-history');
const ROOT = path.join(__dirname, '..');
const STATE_FILE = path.join(ROOT, 'data', 'qq-forward-state.json');
const ANCHOR_FILE = path.join(ROOT, 'data', 'qq-anchor-names.json');
const AUDIENCE_FILE = path.join(ROOT, 'data', 'qq-audience-uids.json');
const BOT_HISTORY_FILE = path.join(ROOT, 'data', 'qq-bot-history.json');
const LOCK_FILE = path.join(ROOT, 'data', 'qq-forward.lock');
const SENDER_FILE = process.platform === 'win32'
  ? require('./build-qq-sender').senderFile() : path.join(ROOT, 'data', 'qq-sender.exe');
const SENDER_ARGS = ['--data-directory', path.join(ROOT, 'data')];

function atomicSave(state, file = STATE_FILE, io = fs,
  pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)) {
  const temp = file + '.' + process.pid + '.tmp';
  try {
    io.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n');
    // Windows readers or antivirus may hold the destination briefly. Keep the previous file intact.
    for (let attempt = 0; ; attempt++) {
      try { io.renameSync(temp, file); return; }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 10) throw error;
        pause(50);
      }
    }
  } catch (error) {
    try { io.unlinkSync(temp); } catch {}
    throw error;
  }
}
function readStatus(file = STATE_FILE) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { deliveries, ...status } = state;
    return { ...status, running: processAlive(state.pid) && Date.now() - (state.updated || 0) < 30000,
      groupId: settings.GROUP_ID, groupName: settings.GROUP_NAME };
  } catch (e) {
    return { updated: 0, sent: 0, skipped: 0, failed: 0, uncertain: 0,
      running: false, groupId: settings.GROUP_ID, groupName: settings.GROUP_NAME,
      lastError: e.code === 'ENOENT' ? '' : '状态读取失败：' + e.message };
  }
}
function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function lock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' }); return true; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8'));
      if (processAlive(pid)) return false;
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('QQ 转发锁无效，请检查锁文件');
      try { fs.unlinkSync(LOCK_FILE); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw unlinkError; }
    }
  }
  return false;
}
function startWorker() {
  // A cloud service supervisor owns the worker lifecycle.
  if (process.env.QQ_FORWARD_MANAGED === '1') return;
  if (!botConfig.read().active) {
    if (process.platform !== 'win32') throw new Error('QQ 本机转发需要 Windows');
    if (!fs.existsSync(SENDER_FILE)) throw new Error('QQ 发送组件未编译，请双击“启动QQ自动推送.bat”');
  }
  try { if (processAlive(Number(fs.readFileSync(LOCK_FILE, 'utf8')))) return; } catch {}
  const log = fs.openSync(path.join(ROOT, 'data', 'qq-forward-worker.log'), 'a');
  try {
    const child = spawn(process.execPath, [__filename], {
      cwd: ROOT, windowsHide: true, detached: true, stdio: ['ignore', log, log],
    });
    child.on('error', e => console.error('[QQ 转发] ' + e.message)); child.unref();
  } finally { fs.closeSync(log); }
}
function sendNative(payload) {
  return new Promise(resolve => {
    const child = execFile(SENDER_FILE, SENDER_ARGS, { windowsHide: true, timeout: 20000,
      maxBuffer: 128 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (stderr?.trim()) console.error('[QQ 内容校验] ' + stderr.trim());
      try {
        const result = JSON.parse(stdout.trim());
        if (!['sent', 'duplicate', 'notSent', 'unknown'].includes(result.status)) throw new Error('无效发送状态');
        resolve(result);
      } catch {
        resolve({ status: 'unknown', error: error ? error.message : 'QQ 发送组件返回无效结果' });
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}
function diagnoseNative() {
  return new Promise(resolve => {
    execFile(SENDER_FILE, [...SENDER_ARGS, '--diagnose'], { windowsHide: true, timeout: 10000,
      maxBuffer: 128 * 1024, encoding: 'utf8' }, (error, stdout) => {
      try {
        const result = JSON.parse(stdout.trim());
        const controls = result.windows.find(item => Array.isArray(item.controls))?.controls || [];
        const editor = result.windows.some(item => item.messageEditor?.normalizedLength !== undefined);
        const more = controls.some(item => item.id === 'id-func-bar-more');
        const history = result.windows.some(item => item.groupHistory?.readable === true);
        const failure = result.windows.find(item => item.error)?.error;
        console.error('[QQ 只读诊断] ' + JSON.stringify(result));
        resolve({ checkedAt: Date.now(), ready: !failure && editor && more && history,
          error: failure || (editor && more && history ? '' : 'QQ 内部控件不可访问，请打开目标群独立窗口并重新启动推送程序') });
      } catch {
        resolve({ checkedAt: Date.now(), ready: false, error: error?.message || 'QQ 诊断结果无效' });
      }
    });
  });
}
async function main() {
  if (!lock()) return;
  let stopping = false;
  const stop = () => { stopping = true; };
  let bot = null;
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    // A normally launched worker rebuilds its own component after source updates.
    // Keep compilation in the application's runtime folder; never change Windows security labels.
    function prepareNative() {
      if (process.platform !== 'win32') throw new Error('QQ 本机转发需要 Windows');
      const sources = ['qq-sender.cs', 'qq-uia.cs', 'qq-accessibility.cs', 'qq-group-dedup.cs', 'build-qq-sender.js'];
      const binaryTime = fs.existsSync(SENDER_FILE) ? fs.statSync(SENDER_FILE).mtimeMs : 0;
      if (sources.some(file => fs.statSync(path.join(__dirname, file)).mtimeMs > binaryTime))
        require('./build-qq-sender').buildSender();
    }
    let saved;
    try { saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    let mode = '', identity = '', setupError = '';
    const readContext = () => {
      const pushRooms = pushBlocklist.readSettings().rooms;
      const forwardSettings = settings.readSettings();
      forwarder.state.pushBlockedRooms = pushRooms;
      return { settings: { ...forwardSettings, enabled: forwardSettings.enabled
        && !setupError && (mode !== 'official' || bot?.ready()) },
        blocked: [...blocklist.readSettings().rooms, ...pushRooms],
        noticeSettings: notificationSettings.readSettings(), scanSettings: scanSettings.readSettings(),
        live: JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'live-state.json'), 'utf8')) };
    };
    const forwarder = new Forwarder({ state: saved, save: atomicSave, send: sendNative, readContext,
      candidateBuilder: buildCandidate });
    const baseCandidates = forwarder.candidates.bind(forwarder);
    forwarder.candidates = context => baseCandidates(context).filter(p => mode !== 'official' || bot?.covered(p));
    const stillEligible = payload => {
      const context = forwarder.context();
      return !!context && forwarder.candidates(context).some(p => sameCandidate(p, payload));
    };
    const guard = payload => {
      const fresh = refreshForward(payload, forwarder.context());
      return !!fresh && fresh.audienceCount === payload.audienceCount;
    };
    async function syncTransport() {
      try {
        const config = botConfig.read();
        const next = config.active ? 'official' : 'native';
        const key = next + ':' + config.appId + ':' + config.appSecret;
        if (key !== identity) {
          bot?.stop(); bot = null; mode = next; identity = '';
          if (mode === 'official') {
            if (!config.appId || !config.appSecret) throw new Error('请配置官方机器人凭证');
            let history;
            try { history = JSON.parse(fs.readFileSync(BOT_HISTORY_FILE, 'utf8')); }
            catch (error) { if (error.code !== 'ENOENT') throw new Error('官方机器人查重记录读取失败'); }
            bot = new QQBotClient({ config, readConfig: botConfig.read, writeConfig: botConfig.write, guard,
              history: new BotHistory({ saved: history, appId: config.appId, save: s => atomicSave(s, BOT_HISTORY_FILE) }) });
            bot.start();
          } else {
            prepareNative(); forwarder.state.readiness = await diagnoseNative();
          }
          identity = key;
        }
        setupError = '';
      } catch (error) {
        bot?.stop(); bot = null; identity = ''; mode = 'official'; setupError = error.message;
      }
      forwarder.state.transport = mode;
      forwarder.state.official = mode === 'official' ? bot?.status()
        || { appId: '', connected: false, ready: false, error: setupError } : undefined;
      if (mode === 'official') forwarder.state.readiness = { checkedAt: Date.now(), ready: !!bot?.ready(),
        error: setupError || bot?.status().error || '' };
    }
    let anchorCache = {};
    try { anchorCache = JSON.parse(fs.readFileSync(ANCHOR_FILE, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') console.error('[QQ 主播缓存] ' + error.message); }
    const resolveAnchor = require('./qq-anchor-name').createAnchorResolver({ saved: anchorCache,
      save: cache => atomicSave(cache, ANCHOR_FILE) });
    let audienceCache = {};
    try { audienceCache = JSON.parse(fs.readFileSync(AUDIENCE_FILE, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') console.error('[QQ 人数缓存] 无法读取，重新查询主播 UID'); }
    const resolveAudience = require('./qq-audience').createAudienceResolver({ saved: audienceCache,
      save: cache => atomicSave(cache, AUDIENCE_FILE), allowed: stillEligible,
      onState: status => { forwarder.state.audienceLookup = status; atomicSave(forwarder.state); } });
    forwarder.send = async payload => {
      let named;
      // Skip known group duplicates before making any audience requests.
      if (mode === 'official' && bot?.ready() && bot.history.has(payload)) return { status: 'duplicate' };
      try {
        const counted = await resolveAudience(payload);
        const fresh = refreshForward(counted, forwarder.context());
        if (!fresh) return { status: 'notSent', error: '红包已不满足当前推送条件', retryAfterMs: 10000 };
        named = await resolveAnchor(fresh);
        const latest = refreshForward(named, forwarder.context());
        if (!latest) return { status: 'notSent', error: '红包已不满足当前推送条件', retryAfterMs: 10000 };
        named = require('./qq-anchor-name').withAnchor(latest, named.anchorName);
      } catch (error) { return { status: 'notSent', error: error.message, retryAfterMs: error.retryAfterMs || 10000 }; }
      if (mode === 'official') {
        const result = bot ? await bot.send(named) : { status: 'notSent', error: setupError };
        return { ...result, audience: named.audience };
      }
      // Configuration can change while resolving the broadcaster name.
      if (botConfig.read().active || !guard(named)) return { status: 'notSent', error: '推送配置或红包条件已改变' };
      return { ...await sendNative(named), audience: named.audience };
    };
    forwarder.state.pid = process.pid;
    forwarder.state.startedAt = Date.now();
    forwarder.state.audienceLookup = { stage: 'idle', updated: Date.now() };
    await syncTransport();
    atomicSave(forwarder.state);
    while (!stopping) {
      await syncTransport();
      if (mode === 'native' && settings.readSettings().enabled
        && Date.now() - forwarder.state.readiness.checkedAt > 60000) forwarder.state.readiness = await diagnoseNative();
      await forwarder.step();
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  } finally {
    bot?.stop();
    if (Number(fs.readFileSync(LOCK_FILE, 'utf8')) === process.pid) fs.unlinkSync(LOCK_FILE);
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
}
module.exports = { STATE_FILE, SENDER_FILE, readStatus, startWorker, atomicSave, sendNative };
if (require.main === module) main().catch(e => {
  console.error('[QQ 转发停止] ' + e.message); process.exitCode = 1;
});
