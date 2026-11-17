'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const hotRank = require('./hot-rank');
const roomAudience = require('./room-audience');
const FILE = path.join(__dirname, '..', 'data', 'history.sqlite');
const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const id = value => value == null ? '' : String(value);

function packetFromLot(roomId, lot, at) {
  const awards = lot.awards || [];
  const award = awards.find(a => /电池/.test(a.gift_name || '')) || awards[0] || {};
  const battery = /电池/.test(award.gift_name || '') ? num(lot.total_price) / 100 : 0;
  return { kind: 'rp', lid: id(lot.lot_id), room_id: id(roomId),
    award_name: award.gift_name || '', award_num: num(award.num), total_price: num(lot.total_price),
    battery, per_person: battery / Math.max(1, num(award.num)),
    start_time: num(lot.start_time), end_time: num(lot.end_time),
    first_seen: at, last_seen: at, join_requirement: lot.join_requirement,
    rp_type: lot.rp_type, sender: lot.sender_info?.base?.name || '', h5: lot.h5_url,
    raw: lot };
}

// One interpretation is shared by the scanner and the history writer.
function describeResult(kind, result, roomId, at, target = '') {
  const base = { outcome: 'error', reason: result.status, packets: [], hitCount: 0 };
  if (result.status === 'ABORT') return { ...base, outcome: 'cancelled' };
  if (result.status === 'BANNED') return { ...base, outcome: 'banned' };
  if (result.status !== 'OK') return base;
  if (result.code !== 0) return { ...base, reason: 'business' };
  const data = result.data;
  if ((kind === 'audience' && roomAudience.integer(data?.onlineNum) === null)
    || (kind === 'audience-room' && roomAudience.anchorUid(data?.uid) === null)) {
    return { ...base, reason: 'schema' };
  }
  if (kind === 'rp') {
    const lots = data?.lot_info;
    if (lots !== null && (!Array.isArray(lots) || lots.some(l => !l || !l.lot_id
      || (l.awards != null && (!Array.isArray(l.awards) || l.awards.some(a => !a || typeof a !== 'object')))))) {
      return { ...base, reason: 'schema' };
    }
    const packets = (lots || []).map(l => packetFromLot(roomId, l, at));
    const hitCount = packets.filter(p => !p.end_time || p.end_time * 1000 > at).length;
    return { outcome: hitCount ? 'hit' : 'empty', reason: '', packets, hitCount };
  }
  if (kind === 'anchor') {
    if (data != null && (typeof data !== 'object' || Array.isArray(data))) return { ...base, reason: 'schema' };
    const packets = data?.id && data.time > 0 ? [{ kind: 'anchor', lid: id(data.id), room_id: id(roomId),
      award_name: data.award_name || '', award_num: num(data.award_num), battery: 0, per_person: 0,
      first_seen: at, last_seen: at, end_time: (at + data.time * 1000) / 1000, raw: data }] : [];
    return { outcome: packets.length ? 'hit' : 'empty', reason: '', packets, hitCount: packets.length };
  }
  if (kind === 'discovery' && hotRank.isTarget(target)) {
    try { hotRank.parseSnapshot(data); }
    catch { return { ...base, reason: 'schema' }; }
  } else if ((kind === 'discovery' && !Array.isArray(data)) || (kind === 'ip' && !data?.addr)) {
    return { ...base, reason: 'schema' };
  }
  return { ...base, outcome: 'ok', reason: '' };
}

class HistoryStore {
  constructor(file = FILE, { readOnly = false } = {}) {
    this.file = file;
    this.runId = null;
    this.readOnly = readOnly;
    if (!readOnly && file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file, { readOnly });
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
      if (!readOnly) this.initialize();
      if (this.db.prepare('PRAGMA user_version').get().user_version !== 1) throw new Error('不支持的历史库版本');
      if (!readOnly) this.prepareWrites();
    } catch (e) { this.db.close(); throw e; }
  }

  initialize() {
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) throw new Error('历史库由较新版本创建，拒绝覆盖');
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.transaction(() => this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER,
        status TEXT NOT NULL, config_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), round INTEGER NOT NULL,
        kind TEXT NOT NULL, room_id TEXT, tier TEXT, node TEXT, ip TEXT, target TEXT,
        started_at INTEGER NOT NULL, finished_at INTEGER, duration_ms INTEGER,
        outcome TEXT NOT NULL, reason TEXT, http_code INTEGER, business_code INTEGER, hit_count INTEGER
      );
      CREATE INDEX IF NOT EXISTS requests_time ON requests(started_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS requests_room_time ON requests(room_id, started_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS requests_outcome ON requests(outcome);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY, kind TEXT NOT NULL, room_id TEXT NOT NULL, lid TEXT NOT NULL,
        first_seen INTEGER, last_seen INTEGER, imported INTEGER NOT NULL DEFAULT 0,
        observations INTEGER NOT NULL DEFAULT 0, battery REAL NOT NULL, per_person REAL NOT NULL,
        award_num REAL NOT NULL, start_time REAL, end_time REAL, detail_json TEXT NOT NULL,
        UNIQUE(kind, room_id, lid)
      );
      CREATE INDEX IF NOT EXISTS events_time ON events(first_seen DESC, id DESC);
      CREATE INDEX IF NOT EXISTS events_room_time ON events(room_id, first_seen DESC, id DESC);
      CREATE TABLE IF NOT EXISTS request_events (
        request_id INTEGER NOT NULL REFERENCES requests(id), event_id INTEGER NOT NULL REFERENCES events(id),
        PRIMARY KEY(request_id, event_id)
      );
      CREATE TABLE IF NOT EXISTS imports (
        source TEXT PRIMARY KEY, imported_at INTEGER NOT NULL, records INTEGER NOT NULL
      );
      PRAGMA user_version=1;
    `));
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (e) { try { this.db.exec('ROLLBACK'); } catch {} throw e; }
  }

  prepareWrites() {
    this.insertRequest = this.db.prepare(`INSERT INTO requests
      (run_id, round, kind, room_id, tier, node, ip, target, started_at, outcome)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`);
    this.finishRequest = this.db.prepare(`UPDATE requests SET finished_at=?, duration_ms=MAX(0, ?-started_at),
      outcome=?, reason=?, http_code=?, business_code=?, hit_count=? WHERE id=? AND outcome='pending'`);
    this.upsertEvent = this.db.prepare(`INSERT INTO events
      (kind, room_id, lid, first_seen, last_seen, imported, observations, battery, per_person,
       award_num, start_time, end_time, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind, room_id, lid) DO UPDATE SET
        first_seen=COALESCE(MIN(events.first_seen, excluded.first_seen), events.first_seen, excluded.first_seen),
        last_seen=COALESCE(MAX(events.last_seen, excluded.last_seen), events.last_seen, excluded.last_seen),
        imported=CASE WHEN events.observations>0 THEN events.imported ELSE MAX(events.imported, excluded.imported) END,
        observations=events.observations+excluded.observations,
        battery=CASE WHEN COALESCE(excluded.last_seen,0)>=COALESCE(events.last_seen,0) THEN excluded.battery ELSE events.battery END,
        per_person=CASE WHEN COALESCE(excluded.last_seen,0)>=COALESCE(events.last_seen,0) THEN excluded.per_person ELSE events.per_person END,
        award_num=CASE WHEN COALESCE(excluded.last_seen,0)>=COALESCE(events.last_seen,0) THEN excluded.award_num ELSE events.award_num END,
        start_time=CASE WHEN COALESCE(excluded.last_seen,0)>=COALESCE(events.last_seen,0) THEN COALESCE(NULLIF(excluded.start_time,0), events.start_time) ELSE events.start_time END,
        end_time=CASE WHEN COALESCE(excluded.last_seen,0)>=COALESCE(events.last_seen,0) THEN COALESCE(NULLIF(excluded.end_time,0), events.end_time) ELSE events.end_time END,
        detail_json=CASE WHEN COALESCE(excluded.last_seen,0)>=COALESCE(events.last_seen,0) THEN excluded.detail_json ELSE events.detail_json END
      RETURNING id`);
    this.linkEvent = this.db.prepare('INSERT INTO request_events(request_id,event_id) VALUES (?,?)');
  }

  startRun(config, at = Date.now()) {
    if (this.runId) throw new Error('历史记录会话已经启动');
    this.runId = randomUUID();
    this.transaction(() => {
      // A single scanner owns the writer lock; unfinished work belongs to a previous crashed process.
      this.db.prepare("UPDATE requests SET outcome='interrupted', reason='process_exit' WHERE outcome='pending'").run();
      this.db.prepare("UPDATE runs SET status='interrupted' WHERE status='running'").run();
      this.db.prepare("INSERT INTO runs(id,started_at,status,config_json) VALUES (?,?,'running',?)")
        .run(this.runId, at, JSON.stringify(config));
    });
    return this.runId;
  }

  beginRequest(meta) {
    if (!this.runId) throw new Error('历史记录会话未启动');
    return Number(this.insertRequest.run(this.runId, meta.round || 0, meta.kind, meta.roomId || null,
      meta.tier || null, meta.node || null, meta.ip || null, meta.target || null, meta.startedAt).lastInsertRowid);
  }

  putEvent(packet, imported = false) {
    const first = num(packet.first_seen || packet.foundAt) || null;
    const last = num(packet.last_seen || packet.first_seen || packet.foundAt) || null;
    return Number(this.upsertEvent.get(packet.kind, id(packet.room_id), id(packet.lid), first, last,
      imported ? 1 : 0, imported ? 0 : 1, num(packet.battery), num(packet.per_person), num(packet.award_num),
      num(packet.start_time), num(packet.end_time), JSON.stringify(packet)).id);
  }

  completeRequest(requestId, meta, result, at = Date.now()) {
    const summary = describeResult(meta.kind, result, meta.roomId, at, meta.target);
    this.transaction(() => {
      const changed = this.finishRequest.run(at, at, summary.outcome, summary.reason,
        result.httpCode ?? null, result.code ?? null, summary.hitCount, requestId).changes;
      if (!changed) throw new Error('请求已完成或不存在: ' + requestId);
      const seen = new Set();
      for (const packet of summary.packets) {
        const key = packet.kind + ':' + packet.room_id + ':' + packet.lid;
        if (seen.has(key)) continue;
        seen.add(key);
        this.linkEvent.run(requestId, this.putEvent(packet));
      }
    });
    return summary;
  }

  importState(state, source, at = Date.now()) {
    if (this.db.prepare('SELECT 1 FROM imports WHERE source=?').get(source)) return 0;
    return this.transaction(() => {
      let count = 0;
      for (const record of [...(state.history || []), ...(state.redpockets || []), ...(state.expired || [])]) {
        if (!record?.lid || !record.room_id) continue;
        this.putEvent({ ...record, kind: 'rp' }, true);
        count++;
      }
      for (const record of state.anchors || []) {
        if (!record?.lid || !record.room_id) continue;
        this.putEvent({ ...record, kind: 'anchor', end_time: num(record.expireAt) / 1000 }, true);
        count++;
      }
      this.db.prepare('INSERT INTO imports(source,imported_at,records) VALUES (?,?,?)').run(source, at, count);
      return count;
    });
  }

  query(type, filters = {}) {
    const events = type === 'events';
    if (!events && type !== 'requests') throw new Error('查询类型无效');
    const table = events ? 'events' : 'requests';
    const time = events ? 'first_seen' : 'started_at';
    const where = [], values = [];
    for (const [key, column] of [['room', 'room_id'], ['kind', 'kind'], ...(!events ? [['outcome', 'outcome']] : [])]) {
      if (filters[key]) { where.push(column + '=?'); values.push(String(filters[key])); }
    }
    for (const [key, operator] of [['from', '>='], ['to', '<']]) {
      if (filters[key] != null) { where.push(time + operator + '?'); values.push(filters[key]); }
    }
    if (events && filters.minPerPerson != null) { where.push('per_person>=?'); values.push(filters.minPerPerson); }
    if (filters.before != null) { where.push('id<?'); values.push(filters.before); }
    const limit = Math.min(200, Math.max(1, num(filters.limit) || 50));
    const rows = this.db.prepare(`SELECT * FROM ${table} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY id DESC LIMIT ?`).all(...values, limit + 1);
    const more = rows.length > limit;
    const items = rows.slice(0, limit).map(row => {
      if (!events) {
        row.event_ids = this.db.prepare('SELECT event_id FROM request_events WHERE request_id=?').all(row.id).map(x => x.event_id);
        return row;
      }
      const { detail_json, ...data } = row;
      return { ...data, detail: JSON.parse(detail_json) };
    });
    return { items, next: more ? items.at(-1).id : null };
  }

  recentBatteryEvidence(since, until) {
    // Rebuild from first actual active observations, never a later repeat or import time.
    return this.db.prepare(`SELECT e.room_id, e.lid, e.detail_json, MIN(r.finished_at) AS found_at
      FROM events e JOIN request_events re ON re.event_id=e.id
      JOIN requests r ON r.id=re.request_id
      WHERE e.kind='rp' AND e.battery>0 AND e.first_seen>=? AND e.first_seen<=?
        AND r.kind='rp' AND r.outcome='hit' AND r.finished_at<=?
        AND (e.end_time=0 OR e.end_time*1000>r.finished_at)
      GROUP BY e.id HAVING MIN(r.finished_at)>=? ORDER BY found_at,e.id`)
      .all(since, until, until, since).map(row => {
        const detail = JSON.parse(row.detail_json);
        // Importing a newer saved state can replace raw with the normalized
        // summary. Its recorded participation gate must survive restoration.
        const lot = detail.raw || { lot_id: row.lid, total_price: detail.total_price,
          awards: [{ gift_name: detail.award_name, num: detail.award_num }],
          start_time: detail.start_time, end_time: detail.end_time,
          join_requirement: detail.join_requirement, rp_type: detail.rp_type };
        return { roomId: row.room_id, foundAt: row.found_at, lot };
      });
  }

  summary() {
    const events = this.db.prepare('SELECT COUNT(*) AS total, SUM(kind=\'rp\') AS redpockets, SUM(imported=1) AS imported FROM events').get();
    const requests = this.db.prepare('SELECT COUNT(*) AS total, MIN(started_at) AS since, MAX(finished_at) AS latest FROM requests').get();
    const outcomes = this.db.prepare('SELECT outcome, COUNT(*) AS count FROM requests GROUP BY outcome').all();
    const run = this.db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 1').get();
    if (run) { run.config = JSON.parse(run.config_json); delete run.config_json; }
    return { events, requests, outcomes, run: run || null };
  }

  endRun(status = 'stopped', at = Date.now()) {
    if (this.runId) this.db.prepare('UPDATE runs SET ended_at=?,status=? WHERE id=?').run(at, status, this.runId);
    this.runId = null;
  }

  close() { this.db.close(); }
}

module.exports = { HistoryStore, describeResult, FILE };
