#!/usr/bin/env node
/**
 * server.js — 本地红包看板 Web 服务
 *
 * 用法：
 *   node server.js            # 默认 http://127.0.0.1:8443/pool
 *   node server.js --port 9000
 *   node server.js --open     # 服务就绪后打开默认浏览器（Windows）
 *
 * 读取 spider.js 写的 live-state.json，每 2 秒刷新一次推给前端。
 * 零依赖，只用 node 内置 http。
 */

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('node:child_process');
const notificationSettings = require('./notification-settings');
const scanSettings = require('./scan-settings');
const qqForwardSettings = require('./qq-forward-settings');
const qqForwardWorker = require('./qq-forward-worker');
const qqBotConfig = require('./qq-bot-config');
const qqPushBlocklist = require('./qq-push-blocklist');
const { HistoryStore, FILE: HISTORY_FILE } = require('./history-store');

const args = process.argv.slice(2);
const pi = args.indexOf('--port');
const PORT = pi >= 0 ? parseInt(args[pi + 1], 10) : 8443;
const STATE_FILE = path.join(__dirname, '..', 'data', 'live-state.json');
const HTML_FILE = path.join(__dirname, 'dashboard.html');

function readState(file = STATE_FILE) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

function isLocalWrite(req) {
  try {
    const address = new URL('http://' + req.headers.host);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname)
      && (!req.headers.origin || req.headers.origin === address.origin)
      && req.headers['sec-fetch-site'] !== 'cross-site';
  } catch { return false; }
}

function createServer(options = {}) {
let historyStore;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  // ── API ─────────────────────────────────────────────────────────────
  if (url.pathname === '/pool/api/qq-bot') {
    const file = options.qqBotConfigFile || qqBotConfig.FILE;
    if (req.method === 'GET') {
      try {
        const config = qqBotConfig.publicConfig(qqBotConfig.read(file));
        const status = qqForwardWorker.readStatus(options.qqForwardStateFile).official;
        json(res, 200, { ok: true, config, status: status?.appId === config.appId ? status : {} });
      } catch (error) { json(res, 500, { ok: false, msg: error.message }); }
      return;
    }
    if (req.method !== 'PUT') { json(res, 405, { ok: false, msg: '仅支持 GET 或 PUT' }); return; }
    if (!isLocalWrite(req)) { json(res, 403, { ok: false, msg: '请从本机配置页保存' }); return; }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
      json(res, 415, { ok: false, msg: '请使用 JSON 配置' }); return;
    }
    let input;
    try {
      let body = '', size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 4096) throw new Error('配置内容过长'); body += chunk.toString('utf8'); }
      input = JSON.parse(body);
    } catch { json(res, 400, { ok: false, msg: '配置格式无效' }); return; }
    try {
      const config = qqBotConfig.configure(input, file);
      (options.startQQWorker || qqForwardWorker.startWorker)();
      json(res, 200, { ok: true, config: qqBotConfig.publicConfig(config) });
    } catch (error) { json(res, 400, { ok: false, msg: error.message }); }
    return;
  }
  if (url.pathname.startsWith('/pool/api/history/')) {
    if (req.method !== 'GET') { json(res, 405, { ok: false, msg: '仅支持 GET' }); return; }
    const type = url.pathname.slice('/pool/api/history/'.length);
    if (!['summary', 'events', 'requests'].includes(type)) { json(res, 404, { ok: false, msg: '无此查询' }); return; }
    const filters = {};
    try {
      for (const [key, value] of url.searchParams) {
        if (!['room', 'kind', 'outcome', 'from', 'to', 'before', 'limit', 'minPerPerson'].includes(key)) throw new Error('未知参数: ' + key);
        if (!value) continue;
        if (['from', 'to', 'before', 'limit', 'minPerPerson'].includes(key)) {
          const n = Number(value);
          if (!Number.isFinite(n) || n < 0 || (key !== 'minPerPerson' && !Number.isSafeInteger(n))) throw new Error(key + ' 必须是非负数');
          if (key === 'limit' && (n < 1 || n > 200)) throw new Error('每页限 1～200 条');
          filters[key] = n;
        } else {
          if (key === 'room' && !/^\d{1,20}$/.test(value)) throw new Error('房间号格式无效');
          if (key === 'kind' && !['rp', 'anchor', 'ip', 'discovery', 'audience', 'audience-room'].includes(value)) throw new Error('类型无效');
          if (key === 'outcome' && !['pending', 'hit', 'empty', 'error', 'banned', 'cancelled', 'interrupted', 'ok'].includes(value)) throw new Error('结果无效');
          filters[key] = value;
        }
      }
      if (filters.from != null && filters.to != null && filters.from >= filters.to) throw new Error('结束时间须晚于开始时间');
      if (type === 'events' && filters.outcome) throw new Error('红包明细不支持结果筛选');
      if (type === 'requests' && filters.minPerPerson != null) throw new Error('扫描记录不支持人均筛选');
    } catch (e) { json(res, 400, { ok: false, msg: e.message }); return; }
    try {
      const file = options.historyFile || HISTORY_FILE;
      if (!fs.existsSync(file)) { json(res, 503, { ok: false, msg: '长期库尚未建立，请先启动扫描器' }); return; }
      historyStore ||= new HistoryStore(file, { readOnly: true });
      json(res, 200, { ok: true, ...(type === 'summary' ? historyStore.summary() : historyStore.query(type, filters)) });
    } catch (e) { json(res, 503, { ok: false, msg: '历史库读取失败：' + e.message }); }
    return;
  }
  if (url.pathname === '/pool/api/qq-forward-status') {
    if (req.method !== 'GET') { json(res, 405, { ok: false, msg: '仅支持 GET' }); return; }
    json(res, 200, { ok: true, ...qqForwardWorker.readStatus(options.qqForwardStateFile) });
    return;
  }
  if (['/pool/api/notification-settings', '/pool/api/scan-settings', '/pool/api/qq-forward-settings',
    '/pool/api/qq-push-blocklist'].includes(url.pathname)) {
    const scanning = url.pathname === '/pool/api/scan-settings';
    const forwarding = url.pathname === '/pool/api/qq-forward-settings';
    const pushBlocking = url.pathname === '/pool/api/qq-push-blocklist';
    const store = pushBlocking ? qqPushBlocklist : forwarding ? qqForwardSettings : scanning ? scanSettings : notificationSettings;
    const label = pushBlocking ? 'QQ 推送屏蔽' : forwarding ? 'QQ 转发' : scanning ? '扫描' : '通知';
    const file = pushBlocking ? options.qqPushBlocklistFile || store.FILE : forwarding ? options.qqForwardSettingsFile || store.FILE
      : scanning ? options.scanSettingsFile || store.FILE : options.settingsFile || store.FILE;
    if (req.method === 'GET') {
      try { json(res, 200, { ok: true, settings: store.readSettings(file) }); }
      catch (e) { json(res, 500, { ok: false, msg: '读取' + label + '设置失败：' + e.message }); }
      return;
    }
    if (req.method !== 'PUT') { json(res, 405, { ok: false, msg: '仅支持 GET 或 PUT' }); return; }
    if (!isLocalWrite(req)) { json(res, 403, { ok: false, msg: '请从本地看板保存设置' }); return; }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
      json(res, 415, { ok: false, msg: '设置必须使用 JSON 格式' }); return;
    }
    let settings;
    try {
      let body = '', size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) { json(res, 413, { ok: false, msg: '设置内容过长' }); return; }
        body += chunk.toString('utf8');
      }
      settings = store.validateSettings(JSON.parse(body));
    } catch (e) { json(res, 400, { ok: false, msg: '设置无效：' + e.message }); return; }
    try {
      if (forwarding && settings.enabled) (options.startQQWorker || qqForwardWorker.startWorker)();
      json(res, 200, { ok: true, settings: store.writeSettings(settings, file) });
    }
    catch (e) { json(res, 500, { ok: false, msg: '保存' + label + '设置失败：' + e.message }); }
    return;
  }
  if (url.pathname === '/pool/api/state') {
    const s = readState(options.stateFile || STATE_FILE);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    if (!s) {
      res.end(JSON.stringify({
        ok: false,
        msg: '扫描器还没启动，或还没写出第一份状态。请先运行 node spider.js',
        now: Date.now(),
      }));
      return;
    }
    res.end(JSON.stringify({ ok: true, ...s }));
    return;
  }

  // ── 页面 ────────────────────────────────────────────────────────────
  if (url.pathname === '/pool/qq-bot') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(path.join(__dirname, 'qq-bot.html'), 'utf8')); return;
  }
  if (url.pathname === '/pool/history') {
    try {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(path.join(__dirname, 'history.html'), 'utf8'));
    } catch { res.end('历史页面读取失败'); }
    return;
  }
  if (url.pathname === '/pool' || url.pathname === '/pool/' || url.pathname === '/') {
    try {
      const html = fs.readFileSync(HTML_FILE, 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('dashboard.html 缺失');
    }
    return;
  }

  // ── 健康检查 ────────────────────────────────────────────────────────
  if (url.pathname === '/health') {
    const s = readState(options.stateFile || STATE_FILE);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: !!s,
      stateAge: s ? Date.now() - s.updated : null,
      round: s ? s.round : null,
    }));
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});
server.on('close', () => { historyStore?.close(); historyStore = null; });
return server;
}

module.exports = { createServer };

if (require.main === module) {
  const server = createServer();
  const dashboardUrl = 'http://127.0.0.1:' + PORT + '/pool';
  function openDashboard() {
    if (!args.includes('--open')) return;
    execFile(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start', '', dashboardUrl], { windowsHide: true }, error => {
      if (error) console.error('浏览器未能自动打开，请手动访问 ' + dashboardUrl + '：' + error.message);
    });
  }
  async function existingDashboard() {
    try {
      const response = await fetch(dashboardUrl, { signal: AbortSignal.timeout(2500), redirect: 'error' });
      if (!response.ok || !/^text\/html\b/i.test(response.headers.get('content-type') || '')) return false;
      const html = await response.text();
      return html.includes('<title>红包蹲点 · 实时看板</title>') && html.includes('id="qq-forward-form"');
    } catch { return false; }
  }
  server.on('error', async error => {
    if (error.code === 'EADDRINUSE' && await existingDashboard()) {
      console.log('看板已在运行：' + dashboardUrl);
      openDashboard();
      return;
    }
    console.error(error.code === 'EADDRINUSE'
      ? '看板启动失败：端口 ' + PORT + ' 已被其他服务占用，未识别到可用的红包看板。'
      : '看板启动失败：' + error.message);
    process.exitCode = 1;
  });
  server.listen(PORT, '127.0.0.1', () => {
    try { if (qqForwardSettings.readSettings().enabled) qqForwardWorker.startWorker(); }
    catch (error) { console.error('[QQ 转发] ' + error.message); }
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║   红包看板已启动                              ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');
    console.log('  地址: http://127.0.0.1:' + PORT + '/pool');
    console.log('  API : http://127.0.0.1:' + PORT + '/pool/api/state');
    console.log('');
    console.log('  数据源: ' + STATE_FILE);
    console.log('  状态  : ' + (readState() ? '已就绪' : '等待 spider.js 启动'));
    console.log('');
    console.log('  按 Ctrl+C 停止');
    openDashboard();
  });
}
