'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateNodes, appendNodes, pinAddress } = require('../deploy/instabox/authorized-nodes');
function ss(i) { return { name: 'node-' + i, type: 'ss', server: 'entry.example', port: 1234,
  cipher: 'aes-128-gcm', password: 'test-only-' + i, udp: true }; }
function vmess(i) { return { name: 'node-' + i, type: 'vmess', server: 'ws.example', port: 443,
  cipher: 'auto', uuid: 'test-only-uuid', alterId: 0, network: 'ws', tls: false,
  'ws-opts': { path: '/route', headers: { Host: 'origin.example' } } }; }
test('expansion appends mixed protocols without replacing existing credentials or selecting unverified nodes', () => {
  const original = { proxies: Array.from({length:8}, (_,i) => ss(i)), secret: 'private-controller',
    'proxy-groups': [{name:'scan-exits',proxies:['node-1','node-2','node-3']}], dns: {enable:true} };
  const before = structuredClone(original), additions = [vmess(8),vmess(9),vmess(10),ss(11)];
  const expanded = appendNodes(original, additions);
  assert.deepEqual(original, before);
  assert.deepEqual(expanded.proxies.slice(0,8), before.proxies);
  assert.deepEqual(expanded['proxy-groups'], before['proxy-groups']);
  assert.equal(expanded.secret, before.secret);
  assert.equal(expanded.proxies.length, 12);
  expanded.proxies[8]['ws-opts'].headers.Host = 'changed.example';
  assert.equal(additions[0]['ws-opts'].headers.Host, 'origin.example');
});
test('append rejects duplicate identities, unsupported protocols, incomplete credentials and excess candidates', () => {
  const config = {proxies:[ss(0),ss(1),ss(2)]};
  for (const additions of [[ss(0)], [ss(3),ss(3)], [{...vmess(3),uuid:''}],
    [{...ss(3),password:''}], [{...ss(3),type:'socks5'}], [{...ss(3),port:0}],
    Array.from({length:22},(_,i)=>ss(i+3))]) assert.throws(() => appendNodes(config,additions));
  assert.throws(() => validateNodes([ss(0),ss(1)]));
});
test('candidate storage accepts twenty-four while selected exits remain bounded independently', () => {
  const { MAX_SELECTED_EXITS } = require('../deploy/instabox/authorized-nodes');
  assert.equal(validateNodes(Array.from({length:24},(_,i)=>ss(i))).length,24);
  assert.throws(()=>validateNodes(Array.from({length:25},(_,i)=>ss(i))));
  assert.equal(MAX_SELECTED_EXITS,8);
});
test('pinning TLS without an explicit servername preserves the original domain for SNI', () => {
  const original = {...vmess(9),tls:true};
  const pinned = pinAddress(original,'8.8.4.4');
  assert.equal(pinned.servername,original.server);
  assert.equal(original.servername,undefined);
  assert.deepEqual(pinned['ws-opts'],original['ws-opts']);
  assert.equal(pinAddress({...original,server:'8.8.8.8'},'8.8.4.4').servername,undefined);
  assert.equal(pinAddress(original,original.server).servername,undefined);
});
test('pinning a VMess entry address preserves UUID, WebSocket host/path and TLS options', () => {
  const node = {...vmess(8),tls:true,servername:'tls.example','skip-cert-verify':false};
  const pinned = pinAddress(node,'8.8.8.8');
  assert.equal(pinned.server,'8.8.8.8');
  assert.deepEqual({...pinned,server:node.server},node);
  assert.equal(node.server,'ws.example');
});
