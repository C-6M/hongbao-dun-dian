'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveNode, verifiedResolvers } = require('../deploy/instabox/node-dns');
const empty = async () => ({ ok: true, json: async () => ({ Status: 0, Answer: [] }) });
test('resolver selection strips provenance suffixes, deduplicates and uses the verified address only', () => {
  const result=verifiedResolvers([{address:'8.8.8.8',candidates:[{address:'8.8.8.8',
    sources:['https://dns.google/dns-query#via-current-proxy','https://dns.google/dns-query','local-system-dns']},
    {address:'8.8.4.4',sources:['https://cloudflare-dns.com/dns-query']}]}]);
  assert.deepEqual(result,['https://dns.google/dns-query']);
  assert.deepEqual(verifiedResolvers([{address:'8.8.8.8',candidates:[]}]),[]);
});
test('DNS fallback uses the existing proxy only when direct sources have no public IPv4', async () => {
  const calls = [];
  const rows = await resolveNode('entry.example', { proxy: 'http://127.0.0.1:7890',
    system: async () => [{ address: '127.0.0.1' }], request: empty,
    execute: async (command, args) => { calls.push({ command, args });
      return { stdout: JSON.stringify({ Status: 0, Answer: [{ type: 1, data: '8.8.8.8', TTL: 60 }] }) }; } });
  assert.equal(calls.length,2);
  assert.ok(calls.every(call => call.command === 'curl' && call.args.includes('http://127.0.0.1:7890')));
  assert.equal(rows.filter(row => row.source.endsWith('#via-current-proxy')).length,2);
  assert.equal(rows.at(-1).addresses[0].address,'8.8.8.8');
});
test('public direct answers avoid proxy queries and literal addresses avoid all resolvers', async () => {
  const fail = async () => { throw new Error('Must not query'); };
  const rows = await resolveNode('entry.example', { proxy: 'http://127.0.0.1:7890',
    system: async () => [{ address: '8.8.4.4' }], request: empty, execute: fail });
  assert.equal(rows.length,3);
  assert.deepEqual(await resolveNode('8.8.8.8',{system:fail,request:fail,execute:fail}),
    [{source:'literal',addresses:[{address:'8.8.8.8'}]}]);
});
test('failed or nonzero DoH replies do not become candidate addresses', async () => {
  const rows = await resolveNode('entry.example', { proxy: 'http://127.0.0.1:7890',
    system: async () => [], request: empty,
    execute: async () => ({stdout:JSON.stringify({Status:3,Answer:[{type:1,data:'8.8.8.8'}]})}) });
  assert.ok(rows.every(row => row.addresses.length===0));
  assert.ok(rows.slice(3).every(row=>row.failed));
});
