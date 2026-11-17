'use strict';
// Build a separate Linux snapshot. Never copy the production data directory.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const output = path.join(__dirname, 'bundle');
const coreFiles = ['spider.js', 'strategy.js', 'restart-priority.js', 'scan-speed.js', 'round-queue.js', 'http-transport.js', 'room-audience.js', 'server.js', 'history-store.js',
  'historical-sources.js', 'hot-rank.js', 'http-result.js', 'qq-evidence.js',
  'redpocket-policy.js', 'notifications.js', 'notification-settings.js',
  'scan-settings.js', 'room-blocklist.js', 'dashboard.html', 'history.html', 'local-scanner.js',
  'qq-forward.js', 'qq-forward-worker.js', 'qq-forward-settings.js', 'qq-anchor-name.js',
  'qq-audience.js', 'qq-bot-client.js', 'qq-bot-config.js', 'qq-bot-history.js',
  'qq-push-blocklist.js', 'qq-bot.html', 'build-qq-sender.js'];
const sha = value => createHash('sha256').update(value).digest('hex');
const written = [];
function write(relative, content) {
  const target = path.resolve(output, relative);
  if (!target.startsWith(output + path.sep)) throw new Error('Invalid bundle target');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  written.push({ path: relative.replaceAll('\\', '/'), sha256: sha(content) });
}
function replaceOnce(text, pattern, replacement, label) {
  const matches = text.match(new RegExp(pattern.source, pattern.flags.replace('g', '') + 'g'));
  if (matches?.length !== 1) throw new Error('Source changed: ' + label);
  return text.replace(pattern, replacement);
}
const sources = [];
for (const name of coreFiles) {
  const raw = fs.readFileSync(path.join(root, 'core', name), 'utf8');
  sources.push({ path: 'core/' + name, sha256: sha(raw) });
  let text = raw;
  if (name === 'spider.js') {
    const originalSecret = raw.match(/^  clashSecret: (['"])(.*?)\1,\s*$/m)?.[2];
    if (!/^  clashSecret: [^\r\n]+,\s*$/m.test(raw)) throw new Error('Controller configuration changed');
    text = replaceOnce(text, /^  clashSecret: [^\r\n]+,\s*$/m,
      "  clashSecret: process.env.SCANNER_CLASH_SECRET || '',", 'controller secret');
    text = replaceOnce(text, /^  proxy: [^\r\n]+,\s*$/m,
      "  proxy: process.env.SCANNER_PROXY || 'http://127.0.0.1:7890',", 'proxy');
    text = replaceOnce(text, /^  group: [^\r\n]+,\s*$/m,
      "  group: process.env.SCANNER_CLASH_GROUP || 'scan-exits',", 'group');
    text = replaceOnce(text, /^const CURL = [^\r\n]+;\s*$/m,
      "const CURL = 'curl';", 'curl path');
    text = replaceOnce(text, /async function discoverClash\(\) \{[\s\S]*?(?=async function pingClash\()/,
      `async function discoverClash() {
  const { validateConfig } = require('../deploy/preflight');
  const config = validateConfig(process.env);
  if (!await pingClash(config.controller)) throw new Error('Cloud controller unavailable');
  return config.controller;
}

`, 'Windows controller discovery');
    if ((originalSecret && text.includes(originalSecret)) || text.includes('Clash.for.Windows-')
      || text.includes('C:\\\\Windows\\\\system32\\\\curl.exe')) {
      throw new Error('Unsanitized configuration in bundle');
    }
  }
  write('core/' + name, text);
}
for (const name of fs.readdirSync(path.join(root, 'tests')).filter(name => name.endsWith('.test.js'))) {
  let text = fs.readFileSync(path.join(root, 'tests', name), 'utf8');
  if (['node-health.test.js', 'authorized-nodes.test.js', 'node-dns.test.js', 'cloud-qq-state.test.js'].includes(name)) {
    text = text.replace(/require\('\.\.\/deploy\/instabox\//g, "require('../deploy/");
  }
  write('tests/' + name, text);
}
// The parser regression uses a public TOP50 response. Omit capture headers/context.
const rankFixture = JSON.parse(fs.readFileSync(path.join(root,
  'docs/hot-rank-20261110/api-sample.json'), 'utf8'));
if (!Array.isArray(rankFixture.response?.data?.list)) throw new Error('Public rank fixture changed');
write('docs/hot-rank-20261110/api-sample.json',
  JSON.stringify({ response: { data: rankFixture.response.data } }) + '\n');
for (const name of ['preflight.js', 'install-runtime.sh', 'install-services.sh', 'scanner.env.example',
  'install-proxy-runtime.js', 'configure-proxy.js', 'diagnose-proxies.js', 'diagnose-connectivity.js',
  'diagnose-dns.js', 'collect-node-dns.js', 'repair-proxy-dns.js', 'activate-verified-exits.js', 'inspect-status.js', 'inspect-speed.js', 'audit-deployment.js',
  'node-health.js', 'manage-node-health.js', 'authorized-nodes.js', 'append-authorized-nodes.js',
  'probe-local-dns-candidates.js', 'node-dns.js', 'screen-saved-candidates.js', 'import-qq-state.js']) {
  let source = fs.readFileSync(path.join(__dirname, name));
  if (name === 'import-qq-state.js') source = source.toString('utf8').replaceAll("require('../../core/", "require('../core/");
  write('deploy/' + name, source);
}
write('data/scan-settings.json', JSON.stringify({ enabled: true }, null, 2) + '\n');
write('data/qq-forward-settings.json', JSON.stringify({ enabled: false }, null, 2) + '\n');
write('data/notification-settings.json', JSON.stringify({ enabled: false,
  minPerPerson: 10, minBattery: 0, minRemainingSeconds: 0 }, null, 2) + '\n');
write('data/room-blocklist.json', JSON.stringify({ rooms: ['22748536'] }, null, 2) + '\n');
write('README.md', fs.readFileSync(path.join(__dirname, 'README.md')));
write('tests/cloud-preflight.test.js', fs.readFileSync(path.join(__dirname, 'cloud-preflight.test.js')));
for (const name of ['proxy-test-cert.pem', 'proxy-test-key.pem']) {
  write('tests/fixtures/' + name, fs.readFileSync(path.join(root, 'tests/fixtures', name)));
}
const manifest = { createdAt: new Date().toISOString(), purpose: 'Linux scanner and QQ official bot services',
  privateDataCopied: false, productionChanged: false, sources, files: written };
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ output, files: written.length, privateDataCopied: false }));
