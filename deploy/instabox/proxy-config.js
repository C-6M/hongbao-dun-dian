'use strict';
// Local-only inspection. No credentials are printed or written by this script.
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('./tooling/node_modules/yaml');
// The active desktop profile has one VPS. The saved scanning profile has the required group.
const sourceFile = 'C:/Users/16586/Downloads/Clash.for.Windows-0.20.16.4-ikuuu/Clash.for.Windows-0.20.16-ikuuu/data/profiles/1755516377928.yml';
function selectNodes(limit = 8) {
  const scanner = fs.readFileSync(path.resolve(__dirname, '../../core/spider.js'), 'utf8');
  const groupName = scanner.match(/^  group: '([^']+)',/m)?.[1];
  if (!groupName) throw new Error('Local strategy group declaration changed');
  const config = YAML.parse(fs.readFileSync(sourceFile, 'utf8'));
  const group = (config['proxy-groups'] || []).find(group => group.name === groupName);
  if (!Array.isArray(group?.proxies) || !Array.isArray(config.proxies)) {
    throw new Error('Active file does not contain a complete direct-node group');
  }
  const byName = new Map(config.proxies.map(node => [node.name, node]));
  const selected = [...new Set(group.proxies)].filter(name => byName.has(name)).slice(0, limit)
    .map(name => structuredClone(byName.get(name)));
  if (selected.length < 3) throw new Error('Fewer than three concrete nodes are available');
  if (selected.some(node => JSON.stringify(node).match(/[A-Z]:\\\\/i))) {
    throw new Error('Selected node has a Windows file path requiring separate migration');
  }
  return selected;
}
function summary(nodes = selectNodes()) {
  const types = {};
  for (const node of nodes) types[node.type] = (types[node.type] || 0) + 1;
  return { sourceFile, selectedNodes: nodes.length, types, nodeCredentialsIncludedIfTransferred: true,
    subscriptionUrlsIncluded: false, localControllerSecretIncluded: false, transmitted: false };
}
function generateNodePayload({ limit = 8, offset = 0 } = {}) {
  if (!Number.isInteger(limit) || !Number.isInteger(offset) || limit < 1 || offset < 0 || limit + offset > 12) {
    throw new Error('Payload must stay within the twelve saved candidates');
  }
  const proxies = selectNodes(limit + offset).slice(offset);
  if (proxies.length !== limit) throw new Error('Requested saved candidates are missing');
  return { proxies };
}
function candidateMetadata() {
  return { nodes: selectNodes(64).slice(8).map((node, i) => ({ index: i + 9,
    server: node.server, port: node.port, type: node.type })) };
}
function outsideNodes() {
  const selected = new Set(selectNodes(64).map(node => node.name));
  const config = YAML.parse(fs.readFileSync(sourceFile, 'utf8'));
  return config.proxies.filter(node => !selected.has(node.name)).map(node => structuredClone(node));
}
function generateOutsidePayload(indices) {
  const nodes = outsideNodes();
  if (!Array.isArray(indices) || !indices.length || indices.length > 12
    || new Set(indices).size !== indices.length
    || indices.some(index => !Number.isInteger(index) || index < 13 || index >= 13 + nodes.length)) {
    throw new Error('Additional payload requires one to twelve valid saved candidate indices');
  }
  const proxies = indices.map(index => nodes[index - 13]);
  require('./authorized-nodes').validateNodes(proxies,1);
  return { proxies };
}
module.exports = { summary, generateNodePayload, candidateMetadata, generateOutsidePayload };
if (require.main === module) console.log(JSON.stringify(summary(), null, 2));
