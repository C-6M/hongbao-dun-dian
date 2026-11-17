'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = process.env.SystemRoot || 'C:\\Windows';
const framework = path.join(root, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const compiler = path.join(framework, 'csc.exe');
function senderFile() {
  if (!process.env.LOCALAPPDATA) throw new Error('找不到本机 LOCALAPPDATA 目录');
  const workspace = path.resolve(__dirname, '..').toLowerCase();
  const key = crypto.createHash('sha256').update(workspace).digest('hex').slice(0, 12);
  return path.join(process.env.LOCALAPPDATA, 'RedpacketWatch', key, 'qq-sender.exe');
}
function buildSender(output = senderFile()) {
  if (process.platform !== 'win32') throw new Error('QQ 发送组件需要 Windows');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  execFileSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/utf8output', '/codepage:65001',
    '/reference:System.Web.Extensions.dll', '/reference:Accessibility.dll', '/out:' + output,
    path.join(__dirname, 'qq-uia.cs'), path.join(__dirname, 'qq-accessibility.cs'),
    path.join(__dirname, 'qq-group-dedup.cs'), path.join(__dirname, 'qq-sender.cs')],
  { windowsHide: true, stdio: 'pipe', encoding: 'utf8' });
  return output;
}
module.exports = { buildSender, senderFile };
if (require.main === module) {
  try {
    const output = buildSender(process.argv[2]);
    console.log('已编译：' + output + '（' + fs.statSync(output).size + ' 字节）');
  } catch (error) {
    console.error(error.stdout || error.stderr || error.message);
    process.exitCode = 1;
  }
}
