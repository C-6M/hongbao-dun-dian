'use strict';
// Narrows the scanner group to freshly verified independent exits, without adding credentials.
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
function main() {
  if (execFileSync('systemctl', ['show', 'hongbao-scanner', '--property=ActiveState', '--value'], { encoding: 'utf8' }).trim() !== 'inactive') {
    throw new Error('Scanner must be stopped');
  }
  const file = '/data/hongbao/proxy/config.yaml';
  const original = fs.readFileSync(file, 'utf8');
  const config = JSON.parse(original);
  const proof = JSON.parse(fs.readFileSync('/data/hongbao/proxy/connectivity-http.json', 'utf8'));
  if (Date.now() - Date.parse(proof.at) > 300000 || proof.configSha256 !==
    createHash('sha256').update(JSON.stringify(config)).digest('hex')) throw new Error('Fresh matching live verification required');
  const groups = new Set();
  const rows = proof.nodes.filter(row => {
    if (!row.zone?.success || !row.redpocket?.validSchema || row.redpocket?.apiCode !== 0
      || row.redpocket?.http !== 200 || row.redpocket?.curlExit !== 0 || !row.exitGroup
      || groups.has(row.exitGroup)) return false;
    groups.add(row.exitGroup); return true;
  });
  if (rows.length < 3) throw new Error('At least three independently verified exits required');
  const group = config['proxy-groups'].find(group => group.name === 'scan-exits');
  group.proxies = rows.slice(0, 8).map(row => {
    const node = config.proxies[row.index - 1];
    if (!node || !group.proxies.includes(node.name)) throw new Error('Verified node does not belong to existing group');
    return node.name;
  });
  const backup = '/data/hongbao/proxy/config.before-exit-filter.yaml';
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, original, { mode: 0o600 });
  try {
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    execFileSync('/data/hongbao/runtime/mihomo', ['-t', '-d', '/data/hongbao/proxy', '-f', file], { stdio: 'ignore' });
  } catch (error) { fs.writeFileSync(file, original, { mode: 0o600 }); throw error; }
  console.log(JSON.stringify({ selectedLiveExits: group.proxies.length, storedAuthorizedNodes: config.proxies.length,
    additionalCredentialsTransferred: false, scannerStarted: false }));
}
try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
