'use strict';
// Append only the credentials explicitly authorized for this expansion, via stdin.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { appendNodes } = require('./authorized-nodes');
const root = '/data/hongbao', dir = root + '/proxy';
function main() {
  if (process.platform !== 'linux' || path.resolve(__dirname, '..') !== root) throw new Error('Cloud install required');
  for (const service of ['hongbao-scanner', 'hongbao-node-health']) {
    const state = execFileSync('systemctl', ['show', service, '--property=ActiveState', '--value'], { encoding: 'utf8' }).trim();
    if (!['inactive', 'failed'].includes(state)) throw new Error('Scanner and maintenance must be stopped');
  }
  const lockFile = root + '/data/scanner.lock';
  if (fs.existsSync(lockFile)) {
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    const command = '/proc/' + Number(lock.pid) + '/cmdline';
    if (fs.existsSync(command) && fs.readFileSync(command, 'utf8').includes(root + '/core/spider.js')) {
      throw new Error('Manual scanner must be stopped');
    }
  }
  const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (Object.keys(payload).length !== 1 || !Array.isArray(payload.proxies)
    || payload.proxies.length < 1 || payload.proxies.length > 12) {
    throw new Error('Expected one to twelve authorized additional candidates');
  }
  const file = dir + '/config.yaml', original = fs.readFileSync(file, 'utf8');
  const config = JSON.parse(original), desired = appendNodes(config, payload.proxies);
  const temporary = dir + '/append-' + randomBytes(8).toString('hex') + '.yaml';
  try {
    fs.writeFileSync(temporary, JSON.stringify(desired, null, 2) + '\n', { mode: 0o600 });
    execFileSync(root + '/runtime/mihomo', ['-t', '-d', dir, '-f', temporary], { stdio: 'ignore' });
    const backup = dir + '/config.before-node-expansion.yaml';
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, original, { mode: 0o600 });
    fs.renameSync(temporary, file); fs.chmodSync(file, 0o600);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  console.log(JSON.stringify({ storedAuthorizedNodes: desired.proxies.length, addedCandidates: payload.proxies.length,
    selectedExitsUnchanged: true, proxyRestarted: false, credentialsPrinted: false }));
}
if (require.main === module) {
  try { main(); } catch { console.error('Node append failed; private connection details suppressed'); process.exitCode = 1; }
}
