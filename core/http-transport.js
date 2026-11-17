'use strict';

const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const net = require('node:net');
const zlib = require('node:zlib');

// One transport belongs to one selected exit. Close it before switching exits.
function createProxyTransport({ proxy, userAgent, concurrency = 5, ca, maxResponseBytes = 4 * 1024 * 1024 }) {
  const endpoint = new URL(proxy);
  if (endpoint.protocol !== 'http:') throw new Error('The pooled transport requires an HTTP proxy');
  const agent = new https.Agent({ keepAlive: true, maxSockets: concurrency,
    maxTotalSockets: concurrency, maxFreeSockets: concurrency, scheduling: 'lifo' });
  const connecting = new Set();
  const active = new Map();
  const waiting = new Set();
  let occupied = 0;
  let closed = false;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Invalid concurrency');

  // Agent limits count established sockets; include asynchronous CONNECT handshakes too.
  function acquire(timeout, signal) {
    return new Promise(resolve => {
      let settled = false;
      const grant = error => {
        if (settled) return;
        settled = true;
        waiting.delete(grant);
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) return resolve({ error });
        occupied++;
        resolve({ release() {
          occupied--;
          if (!closed && occupied < concurrency) waiting.values().next().value?.();
        } });
      };
      const abort = () => grant(new Error('Request cancelled'));
      const timer = setTimeout(() => grant(new Error('Request timed out')), timeout);
      signal?.addEventListener('abort', abort, { once: true });
      if (closed || signal?.aborted) abort();
      else if (occupied < concurrency) grant();
      else waiting.add(grant);
    });
  }

  agent.createConnection = (options, callback) => {
    const signal = options.proxyConnectionSignal;
    const hostname = options.host;
    const destination = (net.isIP(hostname) === 6 ? '[' + hostname + ']' : hostname) + ':' + options.port;
    const headers = { Host: destination };
    if (endpoint.username || endpoint.password) headers['Proxy-Authorization'] = 'Basic '
      + Buffer.from(decodeURIComponent(endpoint.username) + ':' + decodeURIComponent(endpoint.password)).toString('base64');
    const connect = http.request({ hostname: endpoint.hostname, port: endpoint.port || 80,
      method: 'CONNECT', path: destination, headers, agent: false });
    let settled = false, secure;
    const finish = (error, socket) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      connecting.delete(connect);
      if (secure) connecting.delete(secure);
      if (error) { connect.destroy(); secure?.destroy(); }
      callback(error, socket);
    };
    const abort = () => finish(signal.reason || new Error('Proxy connection cancelled'));
    const timer = setTimeout(() => finish(new Error('Proxy connection timed out')), 10000);
    connecting.add(connect);
    // Node can report a late error after a cancelled request has already settled.
    // Keep listeners for the resource lifetime; finish remains idempotent.
    connect.on('error', error => finish(error));
    connect.once('connect', (response, socket, head) => {
      if (settled || closed || response.statusCode !== 200) {
        socket.destroy();
        return finish(new Error('Proxy tunnel was not established'));
      }
      if (head.length) socket.unshift(head);
      secure = tls.connect({ socket, servername: net.isIP(hostname) ? undefined : hostname,
        rejectUnauthorized: true, ca }, () => finish(null, secure));
      connecting.add(secure);
      secure.on('error', error => finish(error));
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (closed || signal?.aborted) finish(signal?.reason || new Error('Transport closed'));
    else connect.end();
  };

  return {
    async request(url, { timeout = 12000, signal } = {}) {
      const startedAt = Date.now();
      const lease = await acquire(timeout, signal);
      if (lease.error) return { err: lease.error, stdout: '' };
      return new Promise(resolve => {
        if (closed || signal?.aborted) { lease.release(); return resolve({ err: new Error('Request cancelled'), stdout: '' }); }
        let target;
        try { target = new URL(url); } catch (err) { lease.release(); return resolve({ err, stdout: '' }); }
        if (target.protocol !== 'https:') { lease.release(); return resolve({ err: new Error('Only HTTPS targets are supported'), stdout: '' }); }
        let done = false, req;
        const connectionController = new AbortController();
        const finish = (err, stdout = '') => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          active.delete(req);
          lease.release();
          resolve({ err, stdout });
        };
        const cancel = error => {
          connectionController.abort(error);
          req?.destroy(error);
          finish(error);
        };
        const abort = () => cancel(new Error('Request cancelled'));
        const timer = setTimeout(() => cancel(new Error('Request timed out')), Math.max(1, timeout - (Date.now() - startedAt)));
        try {
          req = https.request(target, { agent, proxyConnectionSignal: connectionController.signal, headers: { 'user-agent': userAgent,
            'accept-encoding': 'identity', accept: 'application/json' } }, response => {
            const chunks = [];
            let size = 0;
            response.on('data', chunk => {
              size += chunk.length;
              if (size > maxResponseBytes) {
                const error = new Error('Response is too large');
                cancel(error);
              }
              else chunks.push(chunk);
            });
            response.on('error', error => finish(error));
            response.once('end', () => {
              try {
                let body = Buffer.concat(chunks);
                const options = { maxOutputLength: maxResponseBytes };
                switch (response.headers['content-encoding']) {
                  case 'gzip': body = zlib.gunzipSync(body, options); break;
                  case 'deflate': body = zlib.inflateSync(body, options); break;
                  case 'br': body = zlib.brotliDecompressSync(body, options); break;
                }
                finish(null, body.toString('utf8') + '\n###' + response.statusCode);
              } catch (error) { finish(error); }
            });
          });
          active.set(req, cancel);
          req.on('error', error => finish(error));
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
          else req.end();
        } catch (error) { cancel(error); }
      });
    },
    close() {
      closed = true;
      for (const grant of waiting) grant(new Error('Transport closed'));
      for (const cancel of active.values()) cancel(new Error('Transport closed'));
      for (const connection of connecting) connection.destroy(new Error('Transport closed'));
      agent.destroy();
    },
  };
}

module.exports = { createProxyTransport };
