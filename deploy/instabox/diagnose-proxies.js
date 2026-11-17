'use strict';
const fs = require('node:fs');
const { validateConfig } = require('./preflight');
async function main() {
  const config = validateConfig(process.env);
  const headers = { Authorization: 'Bearer ' + config.secret };
  const result = await fetch(config.controller + '/proxies', { headers });
  const data = await result.json();
  const names = data.proxies[config.group].all.filter(name => !['DIRECT', 'REJECT'].includes(name));
  const target = process.argv.includes('--bilibili')
    ? 'https://api.bilibili.com/x/web-interface/zone' : 'https://www.gstatic.com/generate_204';
  const timeout = process.argv.includes('--bilibili') ? 12000 : 5000;
  const rows = [];
  for (let start = 0; start < names.length; start += 2) {
    rows.push(...await Promise.all(names.slice(start, start + 2).map(async (name, offset) => {
      const index = start + offset + 1;
      try {
        const url = config.controller + '/proxies/' + encodeURIComponent(name)
          + '/delay?timeout=' + timeout + '&url=' + encodeURIComponent(target);
        const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeout + 1500) });
        const answer = await response.json();
        return { index, http: response.status, delayMs: answer.delay ?? null,
          working: response.ok && Number.isFinite(answer.delay) };
      } catch { return { index, working: false, reason: 'timeout-or-network' }; }
    })));
  }
  fs.writeFileSync('/data/hongbao/proxy/diagnostics' + (process.argv.includes('--bilibili') ? '-bilibili' : '')
    + '.json', JSON.stringify(rows, null, 2) + '\n');
  console.log(JSON.stringify({ probes: rows, working: rows.filter(row => row.working).length,
    endpoint: target, bilibiliExitsVerified: false }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
