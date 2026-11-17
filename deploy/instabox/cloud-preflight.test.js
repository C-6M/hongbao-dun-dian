'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateConfig, checkController, checkLiveExits } = require('../deploy/preflight');
const env = { SCANNER_CLASH_API: 'http://127.0.0.1:9090',
  SCANNER_PROXY: 'http://127.0.0.1:7890', SCANNER_CLASH_GROUP: 'scan-exits',
  SCANNER_CLASH_SECRET: 'fixture-only' };
test('cloud configuration requires explicit local endpoints', () => {
  assert.throws(() => validateConfig({}), /required/);
  for (const endpoint of ['http://192.0.2.1:9090', 'http://secret@localhost:9090',
    'http://localhost:9090/?key=secret', 'https://localhost:9090']) {
    assert.throws(() => validateConfig({ ...env, SCANNER_CLASH_API: endpoint }), /loopback/);
  }
  assert.equal(validateConfig(env).controller, 'http://127.0.0.1:9090');
});
function liveFixture(ips, invalidRoom = -1) {
  const names = ['a', 'b', 'c'];
  let current = names[0];
  const switches = [];
  return { switches,
    request: async (url, options) => {
      if (options.method === 'PUT') { current = JSON.parse(options.body).name; switches.push(current); return { status: 204 }; }
      return { ok: true, json: async () => ({ all: names, now: 'a' }) };
    },
    query: async url => url.includes('/zone')
      ? { status: 'OK', code: 0, data: { addr: ips[names.indexOf(current)] } }
      : { status: 'OK', code: 0, data: { lot_info: names.indexOf(current) === invalidRoom ? undefined : null } },
    settle: async () => {},
  };
}
test('startup requires live Bilibili room queries through three independent exits', async () => {
  const fixture = liveFixture(['192.0.2.1', '192.0.2.2', '192.0.2.3']);
  assert.deepEqual(await checkLiveExits(validateConfig(env), fixture), {
    verifiedNodes: 3, distinctExits: 3, exitsVerified: true });
  assert.equal(fixture.switches.at(-1), 'a');
});
test('three named nodes with two exit IPs cannot start scanning', async () => {
  const fixture = liveFixture(['192.0.2.1', '192.0.2.1', '192.0.2.2']);
  await assert.rejects(checkLiveExits(validateConfig(env), fixture), /three distinct live exits/);
  assert.equal(fixture.switches.at(-1), 'a');
});
test('IP detection alone cannot certify a node whose redpocket response is invalid', async () => {
  const fixture = liveFixture(['192.0.2.1', '192.0.2.2', '192.0.2.3'], 1);
  await assert.rejects(checkLiveExits(validateConfig(env), fixture), /working=2/);
  assert.equal(fixture.switches.at(-1), 'a');
});
test('startup retries a transport failure once and does not retry a ban', async () => {
  const fixture = liveFixture(['192.0.2.1', '192.0.2.2', '192.0.2.3']);
  const original = fixture.query;
  let failedOnce = false;
  fixture.query = async url => {
    if (!failedOnce) { failedOnce = true; return { status: 'NETWORK' }; }
    return original(url);
  };
  assert.equal((await checkLiveExits(validateConfig(env), fixture)).distinctExits, 3);
  const banned = liveFixture(['192.0.2.1', '192.0.2.2', '192.0.2.3']);
  let calls = 0;
  banned.query = async () => { calls++; return { status: 'BANNED' }; };
  await assert.rejects(checkLiveExits(validateConfig(env), banned), /working=0/);
  assert.equal(calls, 3);
  assert.equal(banned.switches.at(-1), 'a');
});
test('controller readiness excludes built-in and duplicate names without claiming live exits', async () => {
  const config = validateConfig(env);
  const mock = async (url, options) => {
    assert.equal(url, config.controller + '/proxies');
    assert.equal(options.headers.Authorization, 'Bearer fixture-only');
    return { ok: true, json: async () => ({ proxies: {
      'scan-exits': { all: ['DIRECT', 'REJECT', 'a', 'a', 'b', 'c'] },
    } }) };
  };
  assert.deepEqual(await checkController(config, mock), { configuredNodes: 3, exitsVerified: false });
  await assert.rejects(checkController(config, async () => ({ ok: true,
    json: async () => ({ proxies: { 'scan-exits': { all: ['DIRECT', 'a', 'a'] } } }) })), /three/);
  await assert.rejects(checkController(config, async () => ({ ok: false, status: 401 })), /HTTP 401/);
});
