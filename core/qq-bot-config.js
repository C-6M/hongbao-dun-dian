'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const FILE = path.join(__dirname, '..', 'data', 'qq-bot-config.json');
const defaults = () => ({ version: 1, active: false, appId: '', appSecret: '', groupOpenid: '', bindingCode: randomBytes(8).toString('hex') });
function validate(value) {
  if (!value || value.version !== 1 || typeof value.active !== 'boolean'
    || typeof value.appId !== 'string' || value.appId && !/^\d{1,20}$/.test(value.appId)
    || typeof value.appSecret !== 'string' || value.appSecret.length > 256
    || typeof value.groupOpenid !== 'string' || value.groupOpenid && !/^[\w-]{8,128}$/.test(value.groupOpenid)
    || !/^[a-f0-9]{16}$/.test(value.bindingCode)) throw new Error('官方机器人配置格式无效');
  return value;
}
function read(file = FILE) {
  try { return validate(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return defaults(); throw new Error('官方机器人配置读取失败'); }
}
function write(value, file = FILE) {
  validate(value);
  const temp = file + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(temp, file); break; }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 10) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
  }
  catch (error) { try { fs.unlinkSync(temp); } catch {} throw new Error('官方机器人配置保存失败'); }
  return value;
}
function configure(input, file = FILE) {
  if (!input || Object.keys(input).some(k => !['appId', 'appSecret'].includes(k))
    || typeof input.appId !== 'string' || !/^\d{1,20}$/.test(input.appId.trim())
    || typeof input.appSecret !== 'string' || input.appSecret.length > 256) throw new Error('请填写正确的 AppID 和 AppSecret');
  const previous = read(file), appId = input.appId.trim();
  const same = previous.appId === appId;
  const appSecret = input.appSecret.trim() || (same ? previous.appSecret : '');
  if (!appSecret || /\s/.test(appSecret)) throw new Error('请填写 AppSecret');
  return write({ ...(same ? previous : defaults()), active: true, appId, appSecret }, file);
}
function publicConfig(value) {
  return { active: value.active, appId: value.appId, configured: !!(value.appId && value.appSecret),
    bound: !!value.groupOpenid, bindingCommand: '绑定红包推送 ' + value.bindingCode };
}
module.exports = { FILE, defaults, validate, read, write, configure, publicConfig };
