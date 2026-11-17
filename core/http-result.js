'use strict';

function parseHttpResult(stdout, err) {
  const raw = (stdout || '').trimEnd();
  const trailer = raw.match(/\r?\n###(\d{3})$/);
  const httpCode = trailer ? Number(trailer[1]) : 0;
  const body = trailer ? raw.slice(0, trailer.index) : raw;
  if (httpCode === 412 || httpCode === 429 || /security control policy/i.test(body)) {
    return { status: 'BANNED', httpCode };
  }
  if (err || !httpCode) return { status: 'NETWORK', httpCode };
  if (httpCode < 200 || httpCode >= 300) return { status: 'HTTP', httpCode };
  try {
    const j = JSON.parse(body);
    if (!j || typeof j !== 'object') return { status: 'PARSE', httpCode };
    if (j.code === -352 || j.code === -412) return { status: 'BANNED', httpCode, code: j.code };
    return { status: 'OK', httpCode, code: j.code, data: j.data };
  } catch {
    return { status: 'PARSE', httpCode };
  }
}

module.exports = { parseHttpResult };
