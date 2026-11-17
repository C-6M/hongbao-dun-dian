'use strict';
const net = require('node:net');
const MAX_STORED_NODES = 24;
const MAX_SELECTED_EXITS = 8;
function validateNodes(nodes, minimum = 3) {
  if (!Array.isArray(nodes) || nodes.length < minimum || nodes.length > MAX_STORED_NODES
    || new Set(nodes.map(node => node?.name)).size !== nodes.length) {
    throw new Error('Authorized nodes require unique names and a bounded candidate count');
  }
  for (const node of nodes) {
    if (!node || !['ss', 'vmess'].includes(node.type) || typeof node.name !== 'string' || !node.name.trim()
      || typeof node.server !== 'string' || !node.server.trim()
      || !Number.isInteger(node.port) || node.port < 1 || node.port > 65535
      || typeof node.cipher !== 'string' || !node.cipher.trim()
      || (node.type === 'ss' && (typeof node.password !== 'string' || !node.password))
      || (node.type === 'vmess' && (typeof node.uuid !== 'string' || !node.uuid))
      || /[A-Z]:\\\\/i.test(JSON.stringify(node))) {
      throw new Error('Authorized node has unsupported protocol or invalid connection parameters');
    }
  }
  return nodes;
}
function appendNodes(config, additions) {
  validateNodes(config.proxies);
  validateNodes(additions, 1);
  const existing = new Set(config.proxies.map(node => node.name));
  if (additions.some(node => existing.has(node.name))) {
    throw new Error('Authorized additions cannot replace an existing node');
  }
  const desired = structuredClone(config);
  desired.proxies.push(...structuredClone(additions));
  validateNodes(desired.proxies);
  return desired;
}
function pinAddress(node, address) {
  const copy = structuredClone(node);
  if (copy.tls && !copy.servername && !net.isIP(node.server) && net.isIP(address)) {
    copy.servername = node.server;
  }
  copy.server = address;
  return copy;
}
module.exports = { MAX_STORED_NODES, MAX_SELECTED_EXITS, validateNodes, appendNodes, pinAddress };
