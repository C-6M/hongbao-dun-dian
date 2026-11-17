'use strict';
// Run on the cloud machine only after authorization for the selected node credentials.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
function main() {
  if (process.platform !== 'linux') throw new Error('Linux required');
  let payload;
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { throw new Error('Invalid node payload'); }
  const nodes = payload.proxies;
  if (Object.keys(payload).length !== 1 || !Array.isArray(nodes) || nodes.length !== 8
    || nodes.some(node => node.type !== 'ss' || typeof node.name !== 'string' || !node.name
      || typeof node.server !== 'string' || !Number.isInteger(node.port)
      || typeof node.password !== 'string' || typeof node.cipher !== 'string')
    || new Set(nodes.map(node => node.name)).size !== nodes.length) throw new Error('Unexpected node payload');
  const root = path.resolve(__dirname, '..');
  if (root !== '/data/hongbao') throw new Error('Unexpected install directory');
  const proxyDir = path.join(root, 'proxy'); fs.mkdirSync(proxyDir, { recursive: true, mode: 0o700 });
  const secret = randomBytes(24).toString('hex');
  const config = { 'mixed-port': 7890, 'allow-lan': false, 'bind-address': '127.0.0.1',
    'external-controller': '127.0.0.1:9090', secret, mode: 'rule', 'log-level': 'warning',
    ipv6: false, proxies: nodes, 'proxy-groups': [{ name: 'scan-exits', type: 'select',
      proxies: nodes.map(node => node.name) }], rules: ['MATCH,scan-exits'] };
  // JSON is valid YAML; no parser or executable input is needed on the machine.
  const configFile = path.join(proxyDir, 'config.yaml');
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(configFile, 0o600);
  const envFile = path.join(root, 'scanner.env');
  fs.writeFileSync(envFile, 'SCANNER_CLASH_API=http://127.0.0.1:9090\n'
    + 'SCANNER_PROXY=http://127.0.0.1:7890\nSCANNER_CLASH_GROUP=scan-exits\n'
    + 'SCANNER_CLASH_SECRET=' + secret + '\n', { mode: 0o600 });
  fs.chmodSync(envFile, 0o600);
  console.log(JSON.stringify({ configuredNodes: nodes.length, credentialsPrinted: false,
    controllerLoopbackOnly: true, scannerStarted: false }));
}
try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
