#!/usr/bin/env node
// Every stage of one live view, from the viewer, the gateway and the VM, on one timeline, with
// what stopped it (docs/connection-diagnostics.md, "Tracing a session"). Read-only.
//
//   node scripts/session-trace.mjs <session, attempt or browser id> [--hours 24] [--json]
//
// CLOUDFLARE_API_TOKEN needs Workers Observability read, Account Analytics read and D1 read;
// CLOUDFLARE_ACCOUNT_ID names the account. Only the fields the Workers log on purpose are read:
// never request headers, URLs or cookies.
import { readFileSync } from 'node:fs';

const USAGE = 'usage: node scripts/session-trace.mjs <session, attempt or browser id> [--hours 24] [--json]';
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const id = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--hours');
const hours = Math.min(168, Math.max(1, Number(option('--hours', 24)) || 24));
if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
  console.error(USAGE);
  process.exit(2);
}
const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account } = process.env;
if (!token || !account) {
  console.error('Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.');
  process.exit(2);
}
const database = JSON.parse(readFileSync(new URL('../apps/api/wrangler.jsonc', import.meta.url), 'utf8')
  .replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1')).d1_databases[0].database_id;

async function cf(path, body, text = false) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': text ? 'text/plain' : 'application/json' },
    body: text ? body : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || (data && data.success === false)) throw new Error(`${path}: HTTP ${res.status} ${JSON.stringify(data?.errors ?? data).slice(0, 300)}`);
  return data;
}

async function d1(sql, params = []) {
  const data = await cf(`/d1/database/${database}/query`, { sql, params });
  return data.result?.[0]?.results ?? [];
}

// --- Workers logs: only fields the code logs on purpose ------------------------------------
const FIELDS = ['stage', 'code', 'issue', 'source', 'role', 'event', 'instanceId', 'generation', 'sessionId', 'attemptId', 'relayId',
  'peerSequence', 'elapsedMs', 'closeCode', 'wasClean', 'status', 'ignored', 'upMs', 'attempts', 'discardReason', 'clientBuild', 'media',
  // 'vm stream' (agent 0.8.0 heartbeats)
  'viewers', 'seconds', 'levels', 'nacks', 'lost', 'nekoCpuPct', 'cpuPct', 'stealPct'];

async function logs(key, value, from, to) {
  const out = [];
  // Windows of at most 24 h are read unsampled.
  for (let start = from; start < to; start += 24 * 3600_000) {
    let offset;
    for (let page = 0; page < 10; page++) {
      const body = {
        queryId: 'session-trace', view: 'events', limit: 1000,
        timeframe: { from: start, to: Math.min(to, start + 24 * 3600_000) },
        parameters: { datasets: ['cloudflare-workers'], filterCombination: 'and', filters: [{ key, operation: 'eq', type: 'string', value }] },
        ...(offset ? { offset } : {}),
      };
      const events = (await cf('/workers/observability/telemetry/query', body)).result?.events?.events ?? [];
      for (const e of events) {
        const source = e.source && typeof e.source === 'object' ? e.source : {};
        const fields = Object.fromEntries(FIELDS.filter((f) => source[f] !== undefined && source[f] !== null).map((f) => [f, source[f]]));
        out.push({ at: Number(e.timestamp), worker: e.$workers?.scriptName ?? '', message: e.$metadata?.message ?? '', ...fields });
      }
      if (events.length < 1000) break;
      offset = events.at(-1)?.$metadata?.id;
      if (!offset) break;
    }
  }
  return out;
}

// --- Live-quality reports (Analytics Engine) ------------------------------------------------
async function quality(column, value, from) {
  const sql = `SELECT timestamp, blob2 AS country, blob3 AS colo, blob5 AS level, blob6 AS candidate, blob7 AS relay, blob10 AS attempt, blob11 AS build,
    double1 AS duration, double3 AS rtt, double4 AS gateway_rtt, double5 AS fps, double6 AS kbps, double7 AS loss, double8 AS freezes,
    double9 AS freeze_ms, double12 AS dropped, double13 AS width, double14 AS height, double15 AS nacks, double16 AS retransmits,
    double17 AS plis, double18 AS keyframes, double19 AS level_changes, double10 AS held, double20 AS held_target, blob12 AS held_min
    FROM cloudbrowser_live_quality WHERE ${column} = '${value}' AND timestamp > toDateTime(${Math.floor(from / 1000)}) ORDER BY timestamp`;
  try {
    // blob12 is a number as text, '' when unknown: a data point's 20 doubles were all in use.
    return ((await cf('/analytics_engine/sql', sql, true)).data ?? []).map((r) => ({ ...r, held_min: r.held_min ? Number(r.held_min) : -1 }));
  } catch (error) {
    return [{ error: String(error.message ?? error) }];
  }
}

// --- What stopped it --------------------------------------------------------------------------
const STALLS = {
  candidates: 'the viewer never got a relay candidate: its network did not reach the TURN relay (UDP and TCP blocked, a captive portal, a firewall), or the relay refused it',
  ice: 'the relay was reached but no path through it to the VM worked: the VM did not answer connectivity checks (its UDP, its firewall, or neko not listening)',
  dtls: 'a path worked but the encrypted session never opened: large packets lost on the path (VPN or tunnel MTU), or the VM side stopped answering',
  media: 'connected, but no video arrived: the VM did not send (encoder or capture on the VM)',
  decode: 'video arrived but no frame decoded: no keyframe got through (heavy loss) or the device could not decode it',
  render: 'frames decoded but none was shown: the page was hidden, or playback was refused or paused',
};
const TURN_CODES = { 701: 'no answer from a STUN/TURN server', 401: 'TURN credentials refused', 403: 'TURN refused (forbidden)', 437: 'allocation mismatch', 486: 'TURN allocation quota', 508: 'TURN out of capacity' };

function verdict(attempt) {
  const failed = attempt.viewer.filter((e) => e.stage === 'failed');
  const reached = attempt.viewer.filter((e) => e.stage !== 'failed' && e.stage !== 'closed').map((e) => e.stage);
  const shown = attempt.viewer.some((e) => e.stage === 'first_frame');
  if (shown && !failed.length) return 'picture shown';
  if (shown) {
    // An agent tunnel that drops and returns keeps the attempt: a picture after the last failure
    // (events are in time order) is a recovery, not a loss.
    const f = failed.at(-1);
    const lost = `${f.code ?? 'unknown'}${f.issue ? ` (shown to the user as ${f.issue})` : ''}`;
    const again = attempt.viewer.slice(attempt.viewer.indexOf(f) + 1).find((e) => e.stage === 'first_frame');
    return again ? `picture shown, lost (${lost}), then shown again${again.peerSequence !== undefined ? ` on peer ${again.peerSequence}` : ''}` : `picture shown, then lost: ${lost}`;
  }
  if (!failed.length) return attempt.viewer.some((e) => e.stage === 'closed') ? `closed after ${reached.at(-1) ?? 'start'}` : `no failure reported (last stage ${reached.at(-1) ?? 'none'})`;
  const f = failed.at(-1);
  const h = f.media?.handshake;
  const parts = [`failed: ${f.code ?? 'unknown'}${f.issue ? ` (shown to the user as ${f.issue})` : ''} after ${reached.at(-1) ?? 'start'}`];
  if (h?.stalledAt) parts.push(`stalled at ${h.stalledAt}: ${STALLS[h.stalledAt]}`);
  if (h?.turnErrors?.length) parts.push(`TURN/STUN errors: ${h.turnErrors.map((c) => `${c} ${TURN_CODES[c] ?? ''}`.trim()).join(', ')}`);
  if (h?.checksSent !== undefined) parts.push(`connectivity checks answered ${h.checksAnswered ?? 0}/${h.checksSent}`);
  if (f.media?.playback?.visibility === 'hidden') parts.push('the page was hidden');
  return parts.join('\n      ');
}

const time = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
// Each level's own frame rate (STREAM.fps in packages/contracts/src/tiers.ts; square is full's shape-free twin).
const LEVEL_FPS = { full: 30, high: 30, medium: 15, low: 10, square: 30 };
// What the VM saw of the live view over one heartbeat (agent 0.8.0, docs/connection-diagnostics.md).
function vmBits(e) {
  const levels = Object.entries(e.levels ?? {}).map(([id, l]) => `${id} ${l.fps}fps/${l.kbps}kbps${l.starts ? ` started ${l.starts}` : ''}${l.whole ? '' : ' (part)'}`);
  return [`[encoder ${e.levels === undefined ? 'not read' : levels.join(', ') || 'idle'}]`, `[viewers' rtcp nack=${e.nacks ?? '?'} lost=${e.lost ?? '?'}]`,
    `[cpu neko=${e.nekoCpuPct ?? '?'}% vm=${e.cpuPct ?? '?'}% steal=${e.stealPct ?? '?'}%]`, `viewers=${e.viewers ?? '?'}`];
}
/** Where the VM's side fell short over a session: an encoder below its level's frame rate, or CPU. */
function vmVerdict(reports) {
  if (!reports.length) return null;
  const behind = [];
  let judged = 0;
  for (const r of reports) {
    // CPU is judged in the same heartbeat as the slow encoder, not anywhere in the session.
    const starved = r.cpuPct > 85 || r.stealPct > 5;
    for (const [id, l] of Object.entries(r.levels ?? {})) {
      // Only a level that ran the whole heartbeat shows its encoder's rate; 0 is a stall.
      if (!l.whole || !LEVEL_FPS[id]) continue;
      judged++;
      if (l.fps < 0.8 * LEVEL_FPS[id]) behind.push({ what: `${id} ${l.fps}/${LEVEL_FPS[id]} fps`, starved, cpuKnown: typeof r.cpuPct === 'number' });
    }
  }
  const max = (k) => { const v = reports.map((r) => r[k]).filter((x) => typeof x === 'number'); return v.length ? Math.max(...v) : '?'; };
  const parts = [`${reports.length} heartbeats, CPU up to ${max('cpuPct')}% (neko up to ${max('nekoCpuPct')}% of a core), steal up to ${max('stealPct')}%`];
  if (behind.length) {
    const starved = behind.filter((b) => b.starved).length, ample = behind.filter((b) => !b.starved && b.cpuKnown).length;
    const why = [starved && `the VM was out of CPU in ${starved}`, ample && `CPU was not short in ${ample}: look at capture`].filter(Boolean).join(', ');
    parts.push(`the encoder fell behind ${behind.length} time(s): ${[...new Set(behind.map((b) => b.what))].slice(0, 4).join(', ')}${why ? ` (${why})` : ''}`);
  } else if (judged) parts.push(`the encoder kept its frame rate (${judged} level-heartbeats)`);
  else parts.push('the encoder\'s frame rate was not measured: no level ran a whole heartbeat, or neko\'s counters were unreadable');
  return parts.join('; ');
}
/** How long frames waited in the viewer before decoding, over the session's reports, and why. */
function waitVerdict(reports) {
  const timed = reports.filter((r) => !r.error && r.held >= 0 && r.duration > 0);
  if (!timed.length) return null;
  const mean = (k, rs) => Math.round(rs.reduce((a, r) => a + r[k] * r.duration, 0) / rs.reduce((a, r) => a + r.duration, 0));
  const held = mean('held', timed);
  const aimed = timed.filter((r) => r.held_target > 0);
  if (!aimed.length) return `frames waited ${held} ms on average before decoding`;
  // The excess is taken over the reports that carry a target, never one average against another.
  const target = mean('held_target', aimed), heldAimed = mean('held', aimed);
  const why = heldAimed - target > 50 ? `the other ${heldAimed - target} ms, for lost packets to be resent` : 'little waiting for resends';
  // What the path's jitter alone called for, when every report with a target says it too.
  const sync = aimed.every((r) => r.held_min > 0) ? target - mean('held_min', aimed) : 0;
  const synced = sync > 50 ? `; ${sync} ms of that target kept the picture in step with the sound` : '';
  if (aimed.length === timed.length) return `frames waited ${held} ms on average before decoding; the browser aimed for ${target} ms (${why})${synced}`;
  return `frames waited ${held} ms on average before decoding; in the reports that say what the browser aimed for (${aimed.length} of ${timed.length}), ${heldAimed} ms against ${target} ms (${why})${synced}`;
}
function line(e) {
  if (e.message === 'vm stream') return `${time(e.at)}  vm       ${vmBits(e).join(' ')}`;
  const who = e.message === 'viewer connection' ? 'viewer ' : e.worker.includes('gateway') ? 'gateway' : e.worker.padEnd(7).slice(0, 7);
  const bits = [e.stage, e.code, e.issue && `issue=${e.issue}`, e.role && e.role !== 'viewer' && `role=${e.role}`, e.event,
    e.elapsedMs !== undefined && e.message !== 'viewer connection' && `+${e.elapsedMs}ms`, e.closeCode !== undefined && `close=${e.closeCode}`, e.status !== undefined && `status=${e.status}`,
    e.attemptId && `attempt ${e.attemptId.slice(0, 8)}`, e.peerSequence !== undefined && `peer ${e.peerSequence}`, e.upMs !== undefined && `up=${e.upMs}ms`];
  const h = e.media?.handshake;
  if (h) bits.push(`[handshake${h.stalledAt ? ` stalled=${h.stalledAt}` : ''}${h.candidateMs !== undefined ? ` cand=${h.candidateMs}` : ''}${h.iceMs !== undefined ? ` ice=${h.iceMs}` : ''}${h.dtlsMs !== undefined ? ` dtls=${h.dtlsMs}` : ''}${h.turnErrors ? ` turnErr=${h.turnErrors}` : ''}${h.candidates ? ` relays=udp${h.candidates.relayUdp}/tcp${h.candidates.relayTcp}/tls${h.candidates.relayTls}` : ''}${h.checksSent !== undefined ? ` checks=${h.checksAnswered}/${h.checksSent}` : ''}${h.dtlsState ? ` dtls=${h.dtlsState}` : ''}]`);
  const m = e.media;
  if (m?.video) bits.push(`[video bytes=${m.video.bytesReceived ?? '?'} decoded=${m.video.framesDecoded ?? '?'} lost=${m.video.packetsLost ?? '?'} nack=${m.video.nackCount ?? '?'}]`);
  if (m?.rttMs !== undefined || m?.localCandidateType) bits.push(`[path ${m.localCandidateType ?? '?'}${m.relayProtocol ? `/${m.relayProtocol}` : ''} rtt=${m.rttMs ?? '?'}ms]`);
  if (m?.playback) bits.push(`[page ${m.playback.visibility} ${m.playback.paused ? 'paused' : 'playing'} play=${m.playback.playState}]`);
  return `${time(e.at)}  ${who}  ${bits.filter(Boolean).join(' ')}`;
}

// --- Resolve the id and gather ---------------------------------------------------------------
const now = Date.now();
let sessions = await d1('SELECT id, instance_id, started_at, last_seen_at, ended_at, country, user_agent FROM viewer_sessions WHERE id = ?', [id]);
let instanceId = sessions[0]?.instance_id;
let attemptOnly = null;
if (!sessions.length) {
  const [instance] = await d1('SELECT id FROM browser_instances WHERE id = ?', [id]);
  if (instance) {
    instanceId = instance.id;
    sessions = await d1('SELECT id, instance_id, started_at, last_seen_at, ended_at, country, user_agent FROM viewer_sessions WHERE instance_id = ? AND started_at > ? ORDER BY started_at', [id, now - hours * 3600_000]);
  } else {
    // An attempt id: the viewer's own reports name its session.
    attemptOnly = id;
    const found = await logs('attemptId', id, now - hours * 3600_000, now);
    const sessionId = found.find((e) => e.sessionId)?.sessionId;
    if (sessionId) sessions = await d1('SELECT id, instance_id, started_at, last_seen_at, ended_at, country, user_agent FROM viewer_sessions WHERE id = ?', [sessionId]);
    instanceId = sessions[0]?.instance_id ?? found.find((e) => e.instanceId)?.instanceId;
  }
}
if (!sessions.length && !instanceId) {
  console.error(`Nothing found for ${id} in D1 or in the last ${hours} h of logs.`);
  process.exit(1);
}

const [instance] = instanceId ? await d1(`SELECT i.id, i.region_id, i.tier, i.status, i.screen, p.generation, p.provider_region, p.instance_type, h.agent_version, h.chrome_major, h.last_heartbeat_at
  FROM browser_instances i LEFT JOIN placements p ON p.instance_id = i.id AND p.status = 'current' LEFT JOIN instance_health h ON h.instance_id = i.id WHERE i.id = ?`, [instanceId]) : [];

const report = { id, instance, sessions: [] };
for (const s of sessions) {
  const from = Math.max(now - 168 * 3600_000, Number(s.started_at) - 60_000);
  const to = Math.min(now, (s.ended_at ? Number(s.ended_at) : Math.max(Number(s.last_seen_at), now)) + 60_000);
  const viewerEvents = await logs('sessionId', s.id, from, to);
  const attemptIds = [...new Set(viewerEvents.map((e) => e.attemptId).filter(Boolean))].filter((a) => !attemptOnly || a === attemptOnly);
  const gatewayEvents = [];
  for (const a of attemptIds.slice(0, 20)) gatewayEvents.push(...(await logs('attemptId', a, from, to)).filter((e) => e.message !== 'viewer connection'));
  // The VM's tunnel to the gateway over the same time: a drop there explains a 'desktop' failure.
  const fromVm = instanceId ? await logs('instanceId', instanceId, from, to) : [];
  const tunnel = fromVm.filter((e) => e.role === 'agent');
  // The VM's heartbeats while this session could have been watching.
  const until = Number(s.ended_at ?? s.last_seen_at ?? now) + 30_000;
  const vm = fromVm.filter((e) => e.message === 'vm stream' && e.at >= Number(s.started_at) - 30_000 && e.at <= until);
  // The api logs a viewer's report when it arrives, often in a batch: place each at its attempt's
  // start plus its elapsedMs instead. The start is the earliest arrival less its elapsed time.
  const startOf = new Map();
  const reported = viewerEvents.filter((e) => e.message === 'viewer connection' && e.attemptId && e.elapsedMs !== undefined && e.elapsedMs < 600_000);
  for (const e of reported) startOf.set(e.attemptId, Math.min(startOf.get(e.attemptId) ?? Infinity, e.at - e.elapsedMs));
  for (const e of reported) e.at = Math.round(startOf.get(e.attemptId) + e.elapsedMs);
  viewerEvents.sort((a, b) => a.at - b.at);
  const seen = new Set();
  const events = [...viewerEvents.filter((e) => !attemptOnly || e.attemptId === attemptOnly), ...gatewayEvents, ...tunnel, ...vm]
    .filter((e) => { const k = `${e.at}|${e.message}|${e.stage}|${e.attemptId}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.at - b.at);
  const attempts = attemptIds.sort((a, b) => (startOf.get(a) ?? 0) - (startOf.get(b) ?? 0)).map((a) => {
    const viewer = viewerEvents.filter((e) => e.attemptId === a && e.message === 'viewer connection');
    const first = viewer.find((e) => e.stage === 'first_frame');
    return { attemptId: a, startedAt: viewer[0]?.at, clientBuild: viewer.find((e) => e.clientBuild)?.clientBuild, firstFrameMs: first?.elapsedMs,
      handshake: first?.media?.handshake, verdict: verdict({ viewer }), viewer };
  });
  report.sessions.push({ session: s, events, attempts, vm: vmVerdict(vm), quality: await quality(attemptOnly ? 'blob10' : 'blob9', attemptOnly ?? s.id, from) });
}

if (flag('--json')) {
  console.log(JSON.stringify(report, (k, v) => (k === 'viewer' ? undefined : v), 1));
  process.exit(0);
}
if (instance) {
  console.log(`browser ${instance.id}  region ${instance.region_id} (${instance.provider_region ?? '?'}, ${instance.instance_type ?? '?'}, ${instance.tier})  status ${instance.status}  generation ${instance.generation ?? '?'}`);
  console.log(`  agent ${instance.agent_version ?? '?'}  chrome ${instance.chrome_major ?? '?'}  last heartbeat ${instance.last_heartbeat_at ? time(Number(instance.last_heartbeat_at)) : '?'}`);
}
for (const { session: s, events, attempts, vm, quality: q } of report.sessions) {
  console.log(`\nsession ${s.id}  ${time(Number(s.started_at))} → ${s.ended_at ? time(Number(s.ended_at)) : 'open'}  ${s.country ?? '?'}  ${String(s.user_agent ?? '').slice(0, 120)}`);
  for (const e of events) console.log(`  ${line(e)}`);
  for (const a of attempts) {
    const steps = a.handshake ? ` (candidate ${a.handshake.candidateMs ?? '?'} ms, ICE ${a.handshake.iceMs ?? '?'} ms, DTLS ${a.handshake.dtlsMs ?? '?'} ms after the offer)` : '';
    console.log(`  attempt ${a.attemptId}${a.clientBuild ? ` build ${a.clientBuild}` : ''}: ${a.firstFrameMs !== undefined ? `first frame at ${a.firstFrameMs} ms${steps}; ` : ''}${a.verdict}`);
  }
  console.log(`  vm: ${vm ?? 'no stream reports (agent before 0.8.0, or no viewer connected)'}`);
  if (q.length) {
    const wait = waitVerdict(q);
    if (wait) console.log(`  delay: ${wait}`);
    console.log('  quality (per report):');
    for (const r of q) {
      if (r.error) { console.log(`    ${r.error}`); continue; }
      const v = (x, unit = '') => (x === undefined || x < 0 ? '?' : `${Math.round(x * 100) / 100}${unit}`);
      // Reports from viewers older than these fields read 0 for them, and carry no build.
      if (!r.build) for (const k of ['nacks', 'retransmits', 'plis', 'keyframes', 'level_changes']) r[k] = -1;
      console.log(`    ${r.timestamp}  ${r.level || '?'} ${v(r.width)}x${v(r.height)}  rtt ${v(r.rtt, 'ms')} input ${v(r.gateway_rtt, 'ms')}  ${v(r.fps)} fps ${v(r.kbps)} kbps  loss ${v(r.loss * 100, '%')}  freezes ${v(r.freezes)} (${v(r.freeze_ms, 'ms')})  held ${v(r.held, 'ms')}${r.held_target > 0 ? ` (aimed ${v(r.held_target, 'ms')}${r.held_min > 0 ? `, jitter alone ${v(r.held_min, 'ms')}` : ''})` : ''}  nack ${v(r.nacks)} rtx ${v(r.retransmits)} pli ${v(r.plis)}  level changes ${v(r.level_changes)}  ${r.country}/${r.colo} ${r.candidate}/${r.relay}`);
    }
  }
}
