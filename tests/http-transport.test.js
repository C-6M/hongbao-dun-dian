'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createProxyTransport } = require('../core/http-transport');
const { parseHttpResult } = require('../core/http-result');
// This private key is only for the isolated localhost test server.
const ca = fs.readFileSync(path.join(__dirname, 'fixtures/proxy-test-cert.pem'));
const key = fs.readFileSync(path.join(__dirname, 'fixtures/proxy-test-key.pem'));

async function fixture(t, handler, deny = false, beforeConnect) {
  const sockets = new Set(), transports = [];
  let tunnels = 0;
  const upstream = https.createServer({ cert: ca, key }, handler);
  const proxy = http.createServer();
  for (const server of [upstream, proxy]) server.on('connection', socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
  });
  proxy.on('connect', async (req, socket, head) => {
    tunnels++;
    if (beforeConnect) await beforeConnect(socket);
    if (socket.destroyed) return;
    if (deny) return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    const [host, port] = req.url.split(':');
    const target = net.connect(Number(port), host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) target.write(head);
      socket.pipe(target); target.pipe(socket);
    });
    sockets.add(target);
    target.once('close', () => sockets.delete(target));
    target.on('error', () => socket.destroy());
    socket.on('error', () => target.destroy());
    socket.once('close', () => target.destroy());
  });
  await Promise.all([new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve)),
    new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))]);
  t.after(async () => {
    for (const transport of transports) transport.close();
    for (const socket of sockets) socket.destroy();
    await Promise.all([new Promise(resolve => upstream.close(resolve)), new Promise(resolve => proxy.close(resolve))]);
  });
  return { url: 'https://127.0.0.1:' + upstream.address().port,
    create(options = {}) { const transport = createProxyTransport({ proxy: 'http://127.0.0.1:' + proxy.address().port,
      userAgent: 'scanner-local-test', ca, ...options }); transports.push(transport); return transport; },
    get tunnels() { return tunnels; } };
}

test('sequential requests share one TLS tunnel within an exit', async t => {
  const f = await fixture(t, (req, res) => {
    assert.equal(req.headers['user-agent'], 'scanner-local-test');
    res.end(JSON.stringify({ code: 0, data: { ok: true } }));
  });
  const transport = f.create();
  for (let i = 0; i < 8; i++) {
    const result = await transport.request(f.url);
    assert.equal(result.err, null);
    assert.equal(parseHttpResult(result.stdout, result.err).data.ok, true);
  }
  assert.equal(f.tunnels, 1);
});

test('closing an exit creates a fresh tunnel for the next exit', async t => {
  const f = await fixture(t, (req, res) => res.end('{"code":0}'));
  const first = f.create();
  await first.request(f.url); first.close();
  assert.ok((await first.request(f.url)).err);
  const second = f.create(); await second.request(f.url);
  assert.equal(f.tunnels, 2);
});

test('the pool limits simultaneous requests and reuses tunnels for queued requests', async t => {
  let active = 0, maximum = 0;
  const f = await fixture(t, (req, res) => {
    maximum = Math.max(maximum, ++active);
    setTimeout(() => { active--; res.end('{"code":0}'); }, 20);
  });
  const transport = f.create({ concurrency: 2 });
  const results = await Promise.all(Array.from({ length: 8 }, () => transport.request(f.url)));
  assert.ok(results.every(r => !r.err));
  assert.equal(maximum, 2); assert.equal(f.tunnels, 2);
});

test('compressed responses and ban statuses retain existing parsing behavior', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === '/ban') { res.writeHead(412); res.end('blocked'); }
    else { res.setHeader('content-encoding', 'gzip'); res.end(zlib.gzipSync('{"code":0,"data":{"count":42}}')); }
  });
  const transport = f.create();
  const good = await transport.request(f.url);
  assert.equal(parseHttpResult(good.stdout, good.err).data.count, 42);
  const ban = await transport.request(f.url + '/ban');
  assert.equal(parseHttpResult(ban.stdout, ban.err).status, 'BANNED');
});

test('timeouts and cancellation settle pending requests and destroy their sockets', async t => {
  const f = await fixture(t, () => {});
  const transport = f.create();
  assert.ok((await transport.request(f.url, { timeout: 50 })).err);
  const controller = new AbortController();
  const pending = transport.request(f.url, { timeout: 1000, signal: controller.signal });
  controller.abort(); assert.ok((await pending).err);
  const before = f.tunnels;
  assert.ok((await transport.request(f.url, { signal: controller.signal })).err);
  assert.equal(f.tunnels, before);
});

test('response size limits apply to both wire bytes and decompressed bytes', async t => {
  const f = await fixture(t, (req, res) => {
    const body = Buffer.from('x'.repeat(5000));
    if (req.url === '/gzip') { res.setHeader('content-encoding', 'gzip'); res.end(zlib.gzipSync(body)); }
    else res.end(body);
  });
  const transport = f.create({ maxResponseBytes: 1024 });
  assert.ok((await transport.request(f.url)).err);
  assert.ok((await transport.request(f.url + '/gzip')).err);
});

test('a rejected proxy tunnel never sends an upstream request', async t => {
  let requests = 0;
  const f = await fixture(t, () => { requests++; }, true);
  const transport = f.create();
  const response = await transport.request(f.url);
  assert.ok(response.err); assert.equal(requests, 0);
});

test('closing a transport settles an active request promptly', async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, () => started());
  const transport = f.create();
  const pending = transport.request(f.url);
  await ready; transport.close();
  assert.ok((await pending).err);
});

for (const outcome of ['timeout', 'cancel']) {
  test('a late proxy connection after ' + outcome + ' does not crash or prevent the next request', { timeout: 5000 }, async t => {
    let releaseTunnel, started, firstClosed, connections = 0, requests = 0;
    const gate = new Promise(resolve => { releaseTunnel = resolve; });
    const ready = new Promise(resolve => { started = resolve; });
    const f = await fixture(t, (req, res) => { requests++; res.end('{"code":0}'); }, false, socket => {
      if (++connections !== 1) return;
      firstClosed = new Promise(resolve => socket.once('close', resolve));
      socket.on('error', () => {});
      started();
      return gate;
    });
    t.after(releaseTunnel);
    const transport = f.create({ concurrency: 1 });
    const controller = new AbortController();
    const pending = transport.request(f.url, { timeout: outcome === 'timeout' ? 100 : 1000, signal: controller.signal });
    await ready;
    if (outcome === 'cancel') controller.abort();
    assert.ok((await pending).err);
    releaseTunnel();
    await firstClosed;
    const next = await transport.request(f.url);
    assert.equal(next.err, null);
    assert.equal(requests, 1);
  });
}

test('closing during a proxy handshake cancels both the active request and queued requests', { timeout: 5000 }, async t => {
  let releaseTunnel, started;
  const gate = new Promise(resolve => { releaseTunnel = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, (req, res) => res.end('{"code":0}'), false, socket => {
    socket.on('error', () => {});
    started();
    return gate;
  });
  t.after(releaseTunnel);
  const transport = f.create({ concurrency: 1 });
  const pending = Array.from({ length: 3 }, () => transport.request(f.url));
  await ready;
  transport.close();
  assert.ok((await Promise.all(pending)).every(result => result.err));
  releaseTunnel();
});
