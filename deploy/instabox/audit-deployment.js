'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const root = '/data/hongbao';
const manifest = JSON.parse(fs.readFileSync(root + '/manifest.json', 'utf8'));
const differences = [];
for (const file of manifest.files) {
  const target = path.resolve(root, file.path);
  if (!target.startsWith(root + '/')) throw new Error('Invalid manifest path');
  const actual = createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  if (actual !== file.sha256) differences.push(file.path);
}
const mode = file => (fs.statSync(file).mode & 0o777).toString(8);
const permissions = { proxyDirectory: mode(root + '/proxy'),
  proxyConfig: mode(root + '/proxy/config.yaml'), scannerEnvironment: mode(root + '/scanner.env') };
const db = new DatabaseSync(root + '/data/history.sqlite', { readOnly: true });
db.exec('PRAGMA query_only=ON');
const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
db.close();
console.log(JSON.stringify({ at: new Date().toISOString(), filesChecked: manifest.files.length,
  differences, permissions, sqliteIntegrity: integrity, privateDataPrinted: false }, null, 2));
if (differences.length || integrity !== 'ok' || permissions.proxyDirectory !== '700'
  || permissions.proxyConfig !== '600' || permissions.scannerEnvironment !== '600') process.exitCode = 1;
