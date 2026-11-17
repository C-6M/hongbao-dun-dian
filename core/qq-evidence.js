'use strict';

const DEFAULTS = {
  qqPolicyVersion: 4,
  qqEvidenceHalfLifeMs: 6 * 3600000,
  qqRecentWindowMs: 2 * 3600000,
  qqRecentIntervalMs: 45000,
  qqRepeatIntervalMs: 30000,
  qqEmptyLimit: 4,
  qqReportRetentionMs: 7 * 86400000,
  qqBackoffSecondEmptyLimit: 8,
  qqBackoffThirdEmptyLimit: 16,
  qqBackoffFirstIntervalMs: 180000,
  qqBackoffSecondIntervalMs: 300000,
  qqBackoffThirdIntervalMs: 300000,
  qqSourceAgingMs: 6 * 3600000,
  qqSourceOldMs: 24 * 3600000,
  qqUsefulMinPerPerson: 10,
};

function parseQQTime(value) {
  if (typeof value !== 'string' || !value.trim()) return 0;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? value.replace(' ', 'T') + '+08:00' : value;
  const time = Date.parse(normalized);
  return Number.isFinite(time) ? time : 0;
}

const validRoom = value => /^\d{4,12}$/.test(String(value || ''));
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;
const recipients = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;

function requirementOf(value) {
  const state = value.requirementState ?? value.requirement_state;
  const requirement = value.joinRequirement ?? value.join_requirement;
  if (state === 'special') return { value: 3, state: 'special' };
  if (state === 'unknown') return { value: 'unknown', state: 'unknown' };
  if (requirement == null) return { value: null, state: 'missing' };
  if ((typeof requirement === 'number' && Number.isInteger(requirement) && requirement >= 0 && requirement <= 2)
    || (typeof requirement === 'string' && /^[012]$/.test(requirement.trim()))) {
    return { value: Number(requirement), state: 'ordinary' };
  }
  return { value: requirement === 3 || requirement === '3' ? 3 : 'unknown',
    state: requirement === 3 || requirement === '3' ? 'special' : 'unknown' };
}

function eligibleReport(report) {
  const requirement = requirementOf(report);
  return !report.requirementConflict && !report.requirement_conflict
    && (requirement.state === 'ordinary' || requirement.state === 'missing');
}

function mergeReport(existing, incoming) {
  const before = requirementOf(existing || {}), after = requirementOf(incoming);
  const requirementConflict = !!existing?.requirementConflict || !!existing?.requirement_conflict
    || !!incoming.requirementConflict || !!incoming.requirement_conflict
    || (before.value != null && after.value != null && before.value !== after.value);
  const requirement = before.state === 'special' ? before : after.state === 'special' ? after
    : before.state === 'unknown' ? before : after.state === 'unknown' ? after
    : requirementConflict ? { value: 'unknown', state: 'unknown' }
    : after.state === 'missing' ? before : after;
  const shareConflict = !!existing?.shareConflict || !!incoming.shareConflict
    || !!(existing?.awardNum && incoming.awardNum && existing.awardNum !== incoming.awardNum);
  const batteryConflict = !!existing?.batteryConflict || !!incoming.batteryConflict
    || !!(existing && positive(existing.battery) !== positive(incoming.battery));
  const earliest = existing && existing.at < incoming.at ? existing : incoming;
  const earliestEnd = existing?.endAt && (!incoming.endAt || existing.endAt < incoming.endAt) ? existing : incoming;
  const previousConfidence = existing && !existing.atSource && incoming.atSource === 'report_scan_time'
    && (!incoming.endAt || String(incoming.endSource).startsWith('remaining_')) ? .5 : existing?.confidence || 0;
  return { ...incoming, at: existing ? Math.min(existing.at, incoming.at) : incoming.at,
    atSource: earliest.atSource || 'legacy_report_time',
    battery: Math.max(positive(existing?.battery), positive(incoming.battery)),
    confidence: Math.max(previousConfidence, incoming.confidence || 0),
    availableAt: Math.min(existing?.availableAt || existing?.at || Infinity, incoming.availableAt || incoming.at),
    endAt: existing?.endAt && incoming.endAt ? Math.min(existing.endAt, incoming.endAt) : existing?.endAt || incoming.endAt || 0,
    endSource: earliestEnd.endSource || (earliestEnd.endAt ? 'explicit_legacy' : ''), endReference: earliestEnd.endReference || '',
    endApproximate: !!earliestEnd.endApproximate,
    awardNum: shareConflict ? 0 : existing?.awardNum || incoming.awardNum || 0,
    joinRequirement: requirement.value, requirementState: requirement.state, requirementConflict,
    messageKeys: [...new Set([...(existing?.messageKeys || []), ...(incoming.messageKeys || [])])],
    shareConflict, batteryConflict };
}

function collect(data, time) {
  const records = new Map();
  for (const item of data.rooms || []) {
    if (!validRoom(item.room)) continue;
    records.set(String(item.room), { item, reports: new Map(), sources: new Set(), anchors: new Set(Array.isArray(item.anchors) ? item.anchors : []) });
  }
  if (!Array.isArray(data.pushes)) return { detailed: false, records, uniqueReports: 0 };
  for (const push of data.pushes) {
    if (!validRoom(push.room) || !positive(push.battery)) continue;
    if (push.award_name && !/电池红包/.test(push.award_name)) continue;
    const messageAt = parseQQTime(push.msg_time);
    const eventAt = parseQQTime(push.push_time);
    const endAt = parseQQTime(push.end_time);
    if ((push.push_time && !eventAt) || (push.msg_time && !messageAt) || (push.end_time && !endAt)) continue;
    const at = eventAt || messageAt;
    if (!at || at > time || (messageAt && messageAt > time)
      || (eventAt && messageAt && eventAt > messageAt) || (endAt && endAt < at)) continue;
    const id = String(push.room);
    if (!records.has(id)) records.set(id, { item: { room: id }, reports: new Map(), sources: new Set(), anchors: new Set() });
    const record = records.get(id);
    // Exact explicit draw times keep the existing deduplication contract. Approximate
    // countdown estimates never establish packet identity or match nearby cross-group reports.
    const inferredEnd = String(push.end_time_source || '').startsWith('remaining_');
    const key = push.lot_id ? 'lot:' + String(push.lot_id)
      : endAt && !inferredEnd ? 'end:' + endAt : 'at:' + at;
    const existing = record.reports.get(key);
    const confidence = endAt && !inferredEnd || eventAt && !push.push_time_source ? 1 : .5;
    const awardNum = recipients(push.award_num);
    const requirement = requirementOf(push);
    const messageKeys = push.message_id != null
      ? [String(push.group_id || push.group || '') + ':' + String(push.message_id)] : [];
    record.reports.set(key, mergeReport(existing, { id: key, at,
      atSource: eventAt ? push.push_time_source || 'legacy_push_time' : 'qq_message_time',
      battery: positive(push.battery), confidence, availableAt: messageAt || at, endAt,
      endSource: push.end_time_source || (endAt ? 'explicit_legacy' : ''),
      endReference: push.end_time_reference || '', endApproximate: !!push.end_time_approximate,
      awardNum, joinRequirement: requirement.value, requirementState: requirement.state,
      requirementText: push.requirement_text || '', left: push.left || '', messageKeys }));
    if (push.group) record.sources.add(String(push.group));
    if (push.anchor) record.anchors.add(String(push.anchor));
  }
  return { detailed: true, records,
    uniqueReports: [...records.values()].reduce((sum, r) => sum + [...r.reports.values()].filter(eligibleReport).length, 0) };
}

function mergeRoom(r, record, detailed, time, cfg) {
  const { item, reports, sources, anchors } = record;
  const previousAt = r.qqLastAt || 0;
  const previousReports = new Map((r.qqReports || []).map(p => [p.id, p]));
  if (detailed) {
    const previousMessages = new Map();
    for (const p of previousReports.values()) {
      for (const key of p.messageKeys || []) previousMessages.set(key, p);
    }
    const matches = new Set();
    const all = [...reports.values()].map(p => {
      const previous = previousReports.get(p.id) || (p.messageKeys || []).map(key => previousMessages.get(key)).find(Boolean);
      if (previous) matches.add(p.id);
      return mergeReport(previous, p);
    }).sort((a, b) => a.at - b.at);
    const eligible = all.filter(eligibleReport);
    const freshReport = eligible.some(p => !matches.has(p.id) && time - p.at < cfg.qqRecentWindowMs
      && (!p.endAt || p.endAt > time) && p.availableAt > (r.lastScan || 0));
    if (freshReport) r.qqMisses = 0;
    r.qqEvidenceVersion = 2;
    r.qqPushes = eligible.length;
    r.qqBattery = eligible.reduce((sum, p) => sum + p.battery, 0);
    r.qqLastAt = eligible.at(-1)?.at || 0;
    r.qqReports = all.filter(p => time - p.at < cfg.qqReportRetentionMs);
    r.qqSources = [...sources];
  } else {
    // Aggregated legacy exports cannot prove a recent burst or justify faster scans.
    r.qqPushes = positive(item.count);
    r.qqBattery = positive(item.total_battery);
    const at = parseQQTime(item.last);
    r.qqLastAt = at > 0 && at <= time ? at : 0;
    delete r.qqReports;
    delete r.qqEvidenceVersion;
    r.qqSources = [];
    if (r.qqLastAt > previousAt && r.qqLastAt > (r.lastScan || 0)) r.qqMisses = 0;
  }
  r.qqLast = r.qqLastAt ? new Date(r.qqLastAt).toISOString() : '';
  r.qqAnchors = [...anchors];
}

function signal(r, time, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  if (r.qqEvidenceVersion !== 1 && r.qqEvidenceVersion !== 2) {
    const age = r.qqLastAt && r.qqLastAt <= time ? time - r.qqLastAt : Infinity;
    return { score: 2 ** (-age / (2 * 86400000)) * (Math.min(80, 20 * Math.log1p(r.qqPushes || 0))
      + Math.min(40, 5 * Math.log1p((r.qqBattery || 0) / 100))), recent: 0, intervalMs: cfg.warmIntervalMs || 90000 };
  }
  let weightedReports = 0, weightedBattery = 0, weightedUseful = 0, weightedKnown = 0;
  let recent = 0, fastRecent = 0, usefulRecent = 0, verifyEndAt = 0;
  for (const report of r.qqReports || []) {
    const age = time - report.at;
    if (!Number.isFinite(age) || age < 0 || age >= cfg.qqReportRetentionMs || !positive(report.battery)
      || !eligibleReport(report)) continue;
    const confidence = report.confidence === .5 ? .5 : 1;
    const weight = confidence * 2 ** (-age / cfg.qqEvidenceHalfLifeMs);
    const awardNum = recipients(report.awardNum);
    const knownShare = awardNum > 0 && !report.shareConflict && !report.batteryConflict;
    const useful = knownShare && report.battery / awardNum >= cfg.qqUsefulMinPerPerson;
    const quality = useful ? 1 : knownShare ? .25 : .5;
    weightedReports += weight * quality;
    weightedBattery += Math.min(report.battery, 1000) * weight * quality;
    if (knownShare) weightedKnown += weight;
    if (useful) weightedUseful += weight;
    if (age < cfg.qqRecentWindowMs) {
      recent += confidence;
      if (useful) usefulRecent += confidence;
      // Expired reports remain historical evidence but do not trigger fast scans.
      if (!report.endAt || report.endAt > time) fastRecent += confidence;
    }
    if (report.endAt > time && (report.availableAt || report.at) > (r.lastAttempt || 0)) {
      verifyEndAt = verifyEndAt ? Math.min(verifyEndAt, report.endAt) : report.endAt;
    }
  }
  const misses = Math.max(0, r.qqMisses || 0);
  const score = (Math.min(160, 65 * Math.log1p(weightedReports))
    + Math.min(30, 3 * Math.log1p(weightedBattery / 100))
    + Math.min(60, 20 * Math.log1p(weightedUseful))) / (1 + misses / cfg.qqEmptyLimit);
  const baseInterval = cfg.warmIntervalMs || 90000;
  let intervalMs = misses >= cfg.qqEmptyLimit ? baseInterval
    : fastRecent >= 2 ? cfg.qqRepeatIntervalMs
    : fastRecent >= 1 ? cfg.qqRecentIntervalMs : baseInterval;
  const sourceAge = r.qqLastAt && r.qqLastAt <= time ? time - r.qqLastAt : Infinity;
  const batteryAge = r.lastBatteryHit ? time - r.lastBatteryHit : Infinity;
  const confirmedWarm = batteryAge >= 0 && batteryAge < (cfg.warmWindowMs || 6 * 3600000);
  if (r.qqLastAt && sourceAge >= cfg.qqRecentWindowMs && !confirmedWarm) {
    const ageFloor = sourceAge >= cfg.qqSourceOldMs ? cfg.qqBackoffSecondIntervalMs
      : sourceAge >= cfg.qqSourceAgingMs ? cfg.qqBackoffFirstIntervalMs : 0;
    const emptyFloor = misses >= cfg.qqBackoffThirdEmptyLimit ? cfg.qqBackoffThirdIntervalMs
      : misses >= cfg.qqBackoffSecondEmptyLimit ? cfg.qqBackoffSecondIntervalMs
      : misses >= cfg.qqEmptyLimit ? cfg.qqBackoffFirstIntervalMs : 0;
    intervalMs = Math.max(intervalMs, ageFloor, emptyFloor);
  }
  const usefulRatio = weightedKnown ? weightedUseful / weightedKnown : null;
  return { score, recent, fastRecent, usefulRecent, usefulRatio,
    schedulingWeight: usefulRatio === null ? 1 : .85 + .3 * usefulRatio,
    intervalMs, backedOff: intervalMs > baseInterval,
    verifyPending: verifyEndAt > time, verifyEndAt };
}

module.exports = { DEFAULTS, parseQQTime, collect, mergeRoom, signal, eligibleReport };
