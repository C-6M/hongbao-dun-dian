'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { gunzipSync } = require('node:zlib');
const { execFileSync } = require('node:child_process');
async function main() {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Linux x64 required');
  // Confirmed against the official release redirect on 2026-11-11; pin the trial.
  const tag = 'v1.19.34';
  const metadata = await fetch('https://api.github.com/repos/MetaCubeX/mihomo/releases/tags/' + tag,
    { headers: { 'User-Agent': 'hongbao-deployment-trial', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(20000) });
  if (!metadata.ok) throw new Error('Official release metadata: HTTP ' + metadata.status);
  const release = await metadata.json();
  const name = 'mihomo-linux-amd64-compatible-' + tag + '.gz';
  const asset = release.assets?.find(asset => asset.name === name);
  if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '')
    || !asset.browser_download_url?.startsWith('https://github.com/MetaCubeX/mihomo/releases/download/' + tag + '/')) {
    throw new Error('Official asset/checksum missing');
  }
  const response = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(90000) });
  if (!response.ok) throw new Error('Official download: HTTP ' + response.status);
  const compressed = Buffer.from(await response.arrayBuffer());
  const actual = 'sha256:' + createHash('sha256').update(compressed).digest('hex');
  if (actual !== asset.digest) throw new Error('Official checksum mismatch');
  const runtime = path.resolve(__dirname, '../runtime'); fs.mkdirSync(runtime, { recursive: true });
  const target = path.join(runtime, 'mihomo');
  fs.writeFileSync(target, gunzipSync(compressed), { mode: 0o755 }); fs.chmodSync(target, 0o755);
  execFileSync(target, ['-v'], { stdio: 'inherit' });
  console.log(JSON.stringify({ version: tag, compressedSha256: actual.slice(7), configCreated: false }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
