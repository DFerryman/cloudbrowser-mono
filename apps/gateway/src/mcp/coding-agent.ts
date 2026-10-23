import { AUTOMATION_LIMITS, type AgentFrame, type AutomationRequest, type ControlState, type GatewayToAgent } from '@cloudbrowser/contracts';
import { createDb, prepaidAccess } from '@cloudbrowser/db';
import type { Env } from '../env.js';
import { connectionLog } from '../connection-log.js';
import { controlMode, withRetry, type LiveInstance } from '../instance-row.js';
import {
  basisShot, BUSY_OTHER_AGENT_MS, mapPoint, mapSteps, newSlotSecret, rememberShot, requestId, sameDigest, sha256Hex,
  shotBounds, SHOT_RING, type McpEnded, type McpRecord, type Shot,
} from './session.js';
import {
  describeControl, describeScreen, hasCoordinates, mimeOf, parseArgs, parseSteps, refusal, textResult, uploadInstructions,
  vmResult, type ShotImage, type ToolArgs, type ToolName, type ToolResult,
} from './tools.js';
import { fromBase64, oneChunk, storeInVm, streamBytes, TransferFailed, type Stored } from './transfer.js';
import { VmLink, VmUnavailable, type VmOutcome } from './vm-link.js';

/**
 * A coding agent's session, held by the browser's Durable Object (docs/agent-access.md). The MCP
 * endpoint is stateless, so this is where the agent's state lives between calls: the session the
 * VM knows, the screenshots its coordinates refer to, its stored files and upload URLs. The record
 * is kept in storage under `mcp` and survives eviction; only requests in flight live in memory.
 *
 * One session per browser. It opens on the first tool call, ends after 15 minutes without a call
 * or 8 hours in all, and a different key takes it over once it has been unused for a minute.
 * Calls run one at a time (get_status excepted), so input from two calls never interleaves.
 */

/** Who is calling, as the Worker authenticated the access key. */
export type Caller = {
  clientId: string;
  userId: string;
  capability: 'control' | 'view';
  keyName: string;
  /** The client's user agent, the fallback for its MCP name. */
  agent: string;
  /** The gateway's public origin, for upload URLs. */
  origin: string;
};

/** What the session needs from the Durable Object that holds it. */
export interface SessionHost {
  readonly ctx: DurableObjectState;
  readonly env: Env;
  /** The VM's tunnel, when it is connected. */
  agent(): WebSocket | undefined;
  sendToAgent(frame: GatewayToAgent): boolean;
  /** The browser's row; null when the browser is gone, undefined when D1 could not be read. Closes nothing. */
  readInstance(instanceId: string): Promise<LiveInstance | null | undefined>;
  controlState(row: LiveInstance): ControlState;
  /** Viewers learn whether a coding agent's session is open and who may drive. */
  statusChanged(row?: LiveInstance): void;
  /** Arms the object's one alarm for this time, unless it is already due sooner. */
  scheduleAlarm(at: number): Promise<void>;
  /** Bumped by every revocation: work begun before one must not finish after it. */
  epoch(): number;
  /** An action counts as activity for auto-sleep, like a viewer's input. */
  touchActivity(instanceId: string, sessionId: string): Promise<void>;
}

type AutomationResult = Extract<AgentFrame, { t: 'automation_result' }>;
type VmRequest = Parameters<VmLink['request']>[0];
type LeaseCheck = 'ok' | 'session_ended' | 'billing_denied' | 'unavailable';

/** The longest act plus a protocol 2 VM's wait for its desktop: a VM silent for longer is not answering. */
export const VM_TIMEOUT_MS = AUTOMATION_LIMITS.maxActMs + 15_000;
/** A protocol 1 VM refuses with desktop_unavailable while the session's desktop opens: asked again this often. */
export const READINESS_RETRY_MS = 1000;
/** The session, key and credit check is reused for this long, like a viewer's input lease. */
const LEASE_MS = 1000;
/** get_status asks the VM for the screen and its capabilities, but does not wait long for them. */
const STATUS_TIMEOUT_MS = 5000;
/** Upload URLs a session may have outstanding; each is single use and lives ten minutes. */
const MAX_UPLOAD_SLOTS = 10;
/** MCP client names learned from `initialize`, per key, until that key opens a session. */
const MAX_CLIENT_NAMES = 16;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** JSON-RPC ids are strings or numbers; `1` and `"1"` are different requests. */
const callKey = (id: unknown) => JSON.stringify(id ?? null);

export function callerOf(req: Request): Caller | null {
  const h = req.headers;
  const clientId = h.get('x-cb-client');
  const userId = h.get('x-cb-user');
  if (!clientId || !userId) return null;
  const decode = (value: string | null) => {
    try { return decodeURIComponent(value ?? ''); } catch { return ''; }
  };
  return {
    clientId, userId, capability: h.get('x-cb-capability') === 'view' ? 'view' : 'control',
    keyName: decode(h.get('x-cb-key-name')).slice(0, 64), agent: decode(h.get('x-cb-agent')).slice(0, 120), origin: h.get('x-cb-origin') ?? '',
  };
}

function unavailable(error: unknown): ToolResult {
  const reason = error instanceof VmUnavailable ? error.reason : 'relay_unavailable';
  if (reason === 'timeout') {
    return textResult('status: timeout\nThe browser did not answer in time; the outcome is unknown. Take a screenshot before acting again.', true);
  }
  if (reason === 'session_closed') {
    return refusal('relay_unavailable', 'The session was closed while this call ran (the key was revoked, access was turned off, or the session ended).');
  }
  return refusal('relay_unavailable');
}

function leaseRefusal(check: Exclude<LeaseCheck, 'ok'>): ToolResult {
  if (check === 'billing_denied') return refusal('browser_unavailable', 'The owner\'s account has no credit available for this browser.');
  return refusal('relay_unavailable', 'The browser\'s access could not be checked just now.');
}

function uploadError(status: number, error: string, message: string) {
  return new Response(`${JSON.stringify({ error, message })}\n`, { status, headers: { 'content-type': 'application/json' } });
}

export class CodingAgentSession {
  /** The stored record; undefined until it was read after a wake. */
  private record: McpRecord | null | undefined;
  private link: VmLink | null = null;
  private calls: Promise<unknown> = Promise.resolve();
  /** The VM stores one transfer at a time per session: inline files and upload URLs take turns. */
  private transfers: Promise<unknown> = Promise.resolve();
  /** The act running in the VM, so a `notifications/cancelled` can stop it. */
  private running: { call: string; clientId: string; vmId: string } | null = null;
  private lease: { sessionId: string | null; epoch: number; until: number } | null = null;
  private readonly controlWaiters = new Set<() => void>();
  private readonly clientNames = new Map<string, string>();

  constructor(private readonly host: SessionHost) {}

  async load(): Promise<McpRecord | null> {
    if (this.record === undefined) this.record = (await this.host.ctx.storage.get<McpRecord>('mcp')) ?? null;
    return this.record;
  }

  /** Whether a session is open; viewers show it. Only meaningful after `load`. */
  get open(): boolean {
    return !!this.record;
  }

  private async save(rec: McpRecord) {
    // A call that finishes after its session closed must not bring the record back.
    if (this.record === rec) await this.host.ctx.storage.put('mcp', rec);
  }

  private linkFor(rec: McpRecord): VmLink {
    if (this.link?.sessionId !== rec.sessionId) {
      this.link = new VmLink(rec.sessionId, (data) => this.host.sendToAgent({ t: 'automation', sessionId: rec.sessionId, data }));
    }
    return this.link;
  }

  /** When the alarm must look at this session next: idle, expiry, or an upload URL lapsing. */
  deadline(rec: McpRecord): number {
    const slots = Object.values(rec.uploads).filter((s) => s.state === 'pending').map((s) => s.expiresAt);
    return Math.min(rec.startedAt + AUTOMATION_LIMITS.maxSessionMs, rec.lastUsedAt + AUTOMATION_LIMITS.idleSessionMs, ...slots);
  }

  // --- requests from the Worker --------------------------------------------------------------

  async fetch(req: Request, path: string, instanceId: string): Promise<Response> {
    if (path === '/mcp/upload') return this.upload(req, instanceId);
    const caller = callerOf(req);
    if (!caller) return new Response('caller required', { status: 400 });
    const body = await req.json<{ id?: unknown; name?: unknown; arguments?: unknown; client?: unknown }>();
    if (path === '/mcp/call') return Response.json(await this.call(caller, instanceId, body.id, body.name as ToolName, body.arguments));
    if (path === '/mcp/cancel') {
      this.cancel(caller, body.id);
      return new Response(null, { status: 204 });
    }
    if (path === '/mcp/hello') {
      await this.hello(caller, typeof body.client === 'string' ? body.client : '');
      return new Response(null, { status: 204 });
    }
    return new Response('not found', { status: 404 });
  }

  /** One tool call. The Worker checked the name; the arguments are checked here, whatever the client sent. */
  async call(caller: Caller, instanceId: string, rpcId: unknown, name: ToolName, raw: unknown): Promise<ToolResult> {
    const parsed = parseArgs(name, raw);
    if (!parsed.ok) return textResult(parsed.message, true);
    connectionLog('mcp_call', { instanceId, role: 'mcp', event: name });
    // Status is read-only and may wait for the user for a while; it never queues behind an act.
    if (name === 'get_status') return this.status(caller, instanceId, (parsed.args as ToolArgs['get_status']).waitForControlMs ?? 0);
    const run = this.calls.then(() => this.run(caller, instanceId, callKey(rpcId), name, parsed.args));
    this.calls = run.catch(() => {});
    return run.catch(() => {
      connectionLog('mcp_call_failed', { instanceId, role: 'mcp', event: name, code: 'internal' });
      return refusal('relay_unavailable', 'The call failed in the gateway; its outcome is unknown. Take a screenshot before acting again.');
    });
  }

  private async run(caller: Caller, instanceId: string, call: string, name: ToolName, args: unknown): Promise<ToolResult> {
    if (name === 'end_session') return this.endSession(caller);
    const admitted = await this.admit(caller, instanceId, name);
    if ('content' in admitted) return admitted;
    const { rec, notices } = admitted;
    switch (name) {
      case 'screenshot': return this.screenshot(rec, args as ToolArgs['screenshot'], notices);
      case 'act': return this.act(rec, instanceId, call, caller, args as ToolArgs['act'], notices);
      case 'upload_file': return this.uploadFile(rec, instanceId, caller, args as ToolArgs['upload_file'], notices);
      case 'attach_files': return this.attach(rec, instanceId, args as ToolArgs['attach_files'], notices);
      default: return refusal('unsupported');
    }
  }

  /**
   * Every call: the browser must be its owner's, running and open to coding agents; the key's
   * capability and the control mode must allow the tool. Then the session is the caller's (open,
   * opened now, or taken over from another key unused for a minute) and its lease is current.
   */
  private async admit(caller: Caller, instanceId: string, tool: ToolName): Promise<{ rec: McpRecord; notices: string[] } | ToolResult> {
    const epoch = this.host.epoch();
    const row = await this.host.readInstance(instanceId);
    if (row === undefined) return refusal('relay_unavailable', 'The browser\'s state could not be read just now.');
    if (!row) {
      await this.close('browser_unavailable');
      return refusal('browser_unavailable', 'This browser no longer exists.');
    }
    if (row.user_id !== caller.userId) return refusal('browser_unavailable');
    if (!row.agent_access) {
      await this.close('access_off', row);
      return refusal('agent_access_off');
    }
    if (row.status !== 'running' || row.desired_state !== 'running' || !row.generation) {
      return refusal('browser_unavailable', `The browser is ${row.status}${row.status === 'running' ? ` and going to ${row.desired_state}` : ''}.`);
    }
    const changesBrowser = tool === 'act' || tool === 'attach_files' || tool === 'upload_file';
    if (changesBrowser && caller.capability === 'view') return refusal('view_only');
    const mode = controlMode(row);
    if (changesBrowser && mode !== 'agent') return refusal(mode === 'privacy' ? 'control_privacy' : 'control_user');
    if (tool === 'screenshot' && mode === 'privacy') return refusal('control_privacy');

    let rec = await this.load();
    // A restarted browser has a fresh VM: whatever the old session held is gone.
    if (rec && rec.generation !== row.generation) {
      await this.close('browser_restarted', row);
      rec = null;
    }
    if (rec && rec.clientId !== caller.clientId) {
      const idleMs = Date.now() - rec.lastUsedAt;
      if (idleMs < BUSY_OTHER_AGENT_MS) {
        return refusal('busy_other_agent', `The key "${rec.keyName}"${rec.clientName ? ` (${rec.clientName})` : ''} used this browser ${Math.round(idleMs / 1000)} s ago; it can be taken over once it has been unused for ${BUSY_OTHER_AGENT_MS / 1000} s.`);
      }
      await this.close('replaced', row);
      rec = null;
    }
    if (rec) {
      const lease = await this.checkLease(instanceId, row, rec.sessionId);
      if (lease === 'session_ended') {
        await this.close('ended', row);
        rec = null;
      } else if (lease !== 'ok') {
        return leaseRefusal(lease);
      }
    }
    const notices: string[] = [];
    if (!rec) {
      const opened = await this.openSession(caller, instanceId, row, epoch);
      if ('content' in opened) return opened;
      rec = opened.rec;
      notices.push(...opened.notices);
    }
    rec.lastUsedAt = Date.now();
    await this.save(rec);
    return { rec, notices };
  }

  /** The session row, its key and the owner's credit, rechecked at most every second. */
  private async checkLease(instanceId: string, row: LiveInstance, sessionId: string | null): Promise<LeaseCheck> {
    const epoch = this.host.epoch();
    const cached = this.lease;
    if (cached && cached.sessionId === sessionId && cached.epoch === epoch && cached.until > Date.now()) return 'ok';
    try {
      const now = Date.now();
      const [session, access] = await withRetry(() => Promise.all([
        sessionId ? this.host.env.DB.prepare(`SELECT s.id FROM automation_sessions s JOIN automation_clients c ON c.id = s.client_id
          WHERE s.id = ? AND s.instance_id = ? AND s.user_id = ? AND s.ended_at IS NULL
            AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > ?)`)
          .bind(sessionId, instanceId, row.user_id, now).first() : Promise.resolve({}),
        prepaidAccess(createDb(this.host.env.DB), row.user_id, instanceId),
      ]));
      if (!session) return 'session_ended';
      if (!access.allowed) {
        connectionLog('mcp_authorization_rejected', { instanceId, generation: row.generation, sessionId: sessionId ?? undefined, role: 'mcp', code: 'billing_denied' });
        return 'billing_denied';
      }
      if (epoch !== this.host.epoch()) return 'unavailable';
      this.lease = { sessionId, epoch, until: Math.min(now + LEASE_MS, access.deadlineAt?.getTime() ?? Infinity) };
      return 'ok';
    } catch {
      connectionLog('mcp_authorization_failed', { instanceId, generation: row.generation, role: 'mcp', code: 'authorization_unavailable' });
      return 'unavailable';
    }
  }

  /** Records the session with the api (audit, Settings), then opens it in the VM. */
  private async openSession(caller: Caller, instanceId: string, row: LiveInstance, epoch: number): Promise<{ rec: McpRecord; notices: string[] } | ToolResult> {
    if (!this.host.agent()) return refusal('relay_unavailable', 'The browser\'s agent is not connected; it may be starting or reconnecting.');
    const billing = await this.checkLease(instanceId, row, null);
    if (billing !== 'ok') return leaseRefusal(billing);
    let sessionId: string;
    try {
      ({ sessionId } = await this.host.env.API.openAutomationSession(instanceId, caller.clientId));
    } catch {
      connectionLog('mcp_session_open_failed', { instanceId, role: 'mcp', code: 'gateway_unavailable' });
      return refusal('relay_unavailable', 'The session could not be opened just now.');
    }
    if (epoch !== this.host.epoch()) {
      this.host.ctx.waitUntil(this.host.env.API.endAutomationSession(sessionId, 'revoked').catch(() => {}));
      return refusal('browser_unavailable');
    }
    const now = Date.now();
    const rec: McpRecord = {
      sessionId, clientId: caller.clientId, userId: caller.userId, generation: row.generation!, startedAt: now, lastUsedAt: now, openedAt: now,
      clientName: this.clientNames.get(caller.clientId) ?? caller.agent, keyName: caller.keyName,
      shots: [], latestShotId: null, handles: {}, uploads: {},
    };
    this.record = rec;
    this.lease = null;
    await this.host.ctx.storage.put('mcp', rec);
    this.host.sendToAgent({ t: 'automation_open', sessionId, clientId: caller.clientId });
    connectionLog('mcp_session_opened', { instanceId, generation: row.generation, sessionId, role: 'mcp' });
    this.host.statusChanged(row);
    await this.host.scheduleAlarm(this.deadline(rec));
    const notices: string[] = [];
    const ended = await this.host.ctx.storage.get<McpEnded>('mcpEnded');
    if (ended && ended.clientId === caller.clientId && ended.reason !== 'ended') {
      notices.push(`note: a new session was opened; the previous one ended (${ended.reason}).${ended.files ? ' File handles from it are gone: upload the files again.' : ''}`);
    }
    return { rec, notices };
  }

  /** Ends the session: the VM drops its files, the api records why, viewers see no agent. Idempotent. */
  async close(reason: string, row?: LiveInstance): Promise<boolean> {
    const rec = await this.load();
    if (!rec) return false;
    this.record = null;
    this.lease = null;
    const link = this.link;
    this.link = null;
    link?.failAll('session_closed');
    this.host.sendToAgent({ t: 'automation_close', sessionId: rec.sessionId });
    this.host.ctx.waitUntil(this.host.env.API.endAutomationSession(rec.sessionId, reason).catch(() => {}));
    connectionLog('mcp_session_closed', { sessionId: rec.sessionId, generation: rec.generation, role: 'mcp', code: reason });
    this.host.statusChanged(row);
    this.controlChanged();
    const ended: McpEnded = { clientId: rec.clientId, reason, at: Date.now(), files: Object.keys(rec.handles).length };
    await this.host.ctx.storage.put('mcpEnded', ended);
    await this.host.ctx.storage.delete('mcp');
    return true;
  }

  /** The api revoked one key (or, without a client id, all of them): its session ends now. */
  async revoke(clientId: string | null): Promise<boolean> {
    const rec = await this.load();
    return !!rec && (!clientId || rec.clientId === clientId) && this.close('client_revoked');
  }

  /** The MCP client named itself in `initialize`; the owner sees it next to a busy refusal. */
  private async hello(caller: Caller, client: string) {
    if (!client) return;
    if (this.clientNames.size >= MAX_CLIENT_NAMES) this.clientNames.delete(this.clientNames.keys().next().value!);
    this.clientNames.set(caller.clientId, client.slice(0, 120));
    const rec = await this.load();
    if (rec && rec.clientId === caller.clientId && rec.clientName !== client) {
      rec.clientName = client.slice(0, 120);
      await this.save(rec);
    }
  }

  /** `notifications/cancelled` for a running act: the VM stops its remaining steps. Its reply is not awaited. */
  cancel(caller: Caller, rpcId: unknown) {
    const running = this.running;
    if (!running || !this.record || running.call !== callKey(rpcId) || running.clientId !== caller.clientId) return;
    this.linkFor(this.record).post({ t: 'cancel', id: requestId(), actionId: running.vmId });
  }

  // --- the VM -------------------------------------------------------------------------------

  /**
   * Sends one request and waits for its result. A protocol 1 VM refuses with desktop_unavailable
   * while the session's desktop is still opening, so that refusal is asked again every second in
   * the session's first 15 s; a protocol 2 VM waits by itself and is never asked twice.
   */
  private async vm(rec: McpRecord, request: VmRequest, onSend?: (vmId: string) => void): Promise<VmOutcome | ToolResult> {
    for (let data = request; ; data = { ...data, id: requestId() }) {
      if (this.record !== rec) return unavailable(new VmUnavailable('session_closed'));
      onSend?.(data.id);
      let outcome: VmOutcome;
      try {
        outcome = await this.linkFor(rec).request(data, VM_TIMEOUT_MS);
      } catch (error) {
        return unavailable(error);
      }
      const { result } = outcome;
      if (result.capabilities) rec.vmProtocol = result.capabilities.protocol;
      if (result.status !== 'rejected' || result.reason !== 'desktop_unavailable' || (rec.vmProtocol ?? 1) >= 2
        || Date.now() - rec.openedAt >= AUTOMATION_LIMITS.readinessMs) return outcome;
      await sleep(READINESS_RETRY_MS);
    }
  }

  /** A VM result as tool content; its screenshot becomes the one later coordinates refer to. */
  private async finish(rec: McpRecord, { result, image }: VmOutcome, notices: readonly string[]): Promise<ToolResult> {
    let shot: ShotImage | undefined;
    if (result.screenshot && image) {
      const s = rememberShot(rec, result.screenshot);
      // Only a protocol 2 VM reports the screen next to a scaled image.
      if (result.screenshot.screenWidth !== undefined) rec.vmProtocol = Math.max(rec.vmProtocol ?? 2, 2);
      await this.save(rec);
      shot = { base64: image, id: s.id, width: s.imageWidth, height: s.imageHeight, screenWidth: s.screenWidth, screenHeight: s.screenHeight };
    }
    return vmResult(result, shot, notices);
  }

  /** Called when the VM's tunnel is (re)accepted: an open session is opened again under the same id. */
  async agentOnline() {
    const rec = await this.load();
    if (!rec) return;
    // A protocol 2 VM resumes the session and keeps its files; a protocol 1 VM (or one not known
    // to be newer) starts it afresh, so its handles would only lead to not_found.
    rec.openedAt = Date.now();
    if ((rec.vmProtocol ?? 1) < 2) rec.handles = {};
    this.host.sendToAgent({ t: 'automation_open', sessionId: rec.sessionId, clientId: rec.clientId });
    await this.save(rec);
  }

  /** The VM's tunnel closed: nothing in flight can be answered any more. */
  agentOffline() {
    this.link?.failAll('relay_unavailable');
  }

  /** A frame for a coding agent's session from the VM; a frame for any other session is stale. */
  async fromAgent(frame: AutomationResult) {
    const rec = await this.load();
    if (!rec || rec.sessionId !== frame.sessionId) return;
    if (frame.data.t === 'control') this.controlChanged();
    else if (frame.data.t !== 'screen') this.linkFor(rec).onFrame(frame.data);
  }

  /** Wakes get_status calls waiting for control to come back. */
  controlChanged() {
    for (const wake of [...this.controlWaiters]) wake();
  }

  private waitForControl(ms: number) {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.controlWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.controlWaiters.add(done);
    });
  }

  /** The alarm: closes an idle or expired session and forgets lapsed upload URLs. Returns the next deadline. */
  async expire(now = Date.now()): Promise<number | null> {
    const rec = await this.load();
    if (!rec) return null;
    if (now >= rec.startedAt + AUTOMATION_LIMITS.maxSessionMs) {
      await this.close('session_expired');
      return null;
    }
    const uploading = Object.values(rec.uploads).some((s) => s.state === 'uploading');
    if (now >= rec.lastUsedAt + AUTOMATION_LIMITS.idleSessionMs) {
      // A call or an upload still running is use: look again shortly.
      if (uploading || this.link?.inFlight) return now + 60_000;
      await this.close('idle');
      return null;
    }
    let changed = false;
    for (const [slotId, slot] of Object.entries(rec.uploads)) {
      if (slot.expiresAt <= now && slot.state !== 'uploading') {
        delete rec.uploads[slotId];
        changed = true;
      }
    }
    if (changed) await this.save(rec);
    return this.deadline(rec);
  }

  // --- tools --------------------------------------------------------------------------------

  private async screenshot(rec: McpRecord, args: ToolArgs['screenshot'], notices: string[]): Promise<ToolResult> {
    const out = await this.vm(rec, { t: 'screenshot', id: requestId(), ...(args.quality ? { quality: args.quality } : {}), ...shotBounds(args.size) });
    return 'content' in out ? out : this.finish(rec, out, notices);
  }

  private async act(rec: McpRecord, instanceId: string, call: string, caller: Caller, args: ToolArgs['act'], notices: string[]): Promise<ToolResult> {
    const parsed = parseSteps(args.steps);
    if (!parsed.ok) return textResult(parsed.message, true);
    // Coordinates are pixels of a screenshot this session took: an unknown one is refused here,
    // before the VM could act on a point that means something else now.
    let basis: Shot | undefined;
    if (hasCoordinates(parsed.steps) || args.screenshotId) {
      basis = basisShot(rec, args.screenshotId);
      if (!basis) return refusal('stale_screenshot', args.screenshotId ? `Screenshot ${args.screenshotId} is not one of this session's last ${SHOT_RING}.` : 'No screenshot yet: take one first, its pixels are the coordinates.');
    }
    const request: Extract<AutomationRequest, { t: 'act' }> = {
      t: 'act', id: requestId(),
      steps: basis ? mapSteps(parsed.steps, basis) : parsed.steps,
      ...(basis ? { screenshotId: basis.id, screenVersion: basis.screenVersion, controlEpoch: basis.controlEpoch } : {}),
      ...(args.settleMs !== undefined ? { settleMs: args.settleMs } : {}),
      ...(args.screenshot !== undefined ? { screenshot: args.screenshot } : {}),
      ...(args.quality ? { quality: args.quality } : {}),
      ...shotBounds(args.size),
    };
    this.host.ctx.waitUntil(this.host.touchActivity(instanceId, rec.sessionId));
    try {
      const out = await this.vm(rec, request, (vmId) => { this.running = { call, clientId: caller.clientId, vmId }; });
      return 'content' in out ? out : await this.finish(rec, out, notices);
    } finally {
      this.running = null;
    }
  }

  private async attach(rec: McpRecord, instanceId: string, args: ToolArgs['attach_files'], notices: string[]): Promise<ToolResult> {
    const unknown = args.handles.filter((h) => !rec.handles[h]);
    if (unknown.length) return refusal('not_found', `Unknown handle${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.`);
    if (args.method === 'picker' && args.handles.length !== 1) {
      return textResult('Invalid arguments for attach_files: the picker method attaches one file per call (Chrome\'s dialog takes one path).', true);
    }
    const point = args.x !== undefined || args.y !== undefined;
    if (point && (args.x === undefined || args.y === undefined)) return textResult('Invalid arguments for attach_files: give both x and y, or neither.', true);
    if (args.method === 'drop' && !point) return textResult('Invalid arguments for attach_files: drop needs x and y, the point of the screenshot where the files are dropped.', true);
    let basis: Shot | undefined;
    if (point || args.screenshotId) {
      basis = basisShot(rec, args.screenshotId);
      if (!basis) return refusal('stale_screenshot', 'Take a screenshot first: x and y are pixels of a screenshot.');
    }
    const request: Extract<AutomationRequest, { t: 'attach' }> = {
      t: 'attach', id: requestId(), handles: args.handles, method: args.method,
      ...(basis && point ? mapPoint(basis, args.x!, args.y!) : {}),
      ...(basis ? { screenshotId: basis.id, screenVersion: basis.screenVersion, controlEpoch: basis.controlEpoch } : {}),
      ...(args.screenshot !== undefined ? { screenshot: args.screenshot } : {}),
      ...(args.quality ? { quality: args.quality } : {}),
      ...shotBounds(args.size),
    };
    this.host.ctx.waitUntil(this.host.touchActivity(instanceId, rec.sessionId));
    const out = await this.vm(rec, request);
    return 'content' in out ? out : this.finish(rec, out, notices);
  }

  private async uploadFile(rec: McpRecord, instanceId: string, caller: Caller, args: ToolArgs['upload_file'], notices: string[]): Promise<ToolResult> {
    if (args.text !== undefined && args.base64 !== undefined) return textResult('Invalid arguments for upload_file: give text or base64, not both.', true);
    const type = args.mimeType || mimeOf(args.name);
    if (args.text !== undefined || args.base64 !== undefined) {
      const bytes = args.text !== undefined ? new TextEncoder().encode(args.text) : fromBase64(args.base64!);
      if (!bytes) return textResult('Invalid arguments for upload_file: base64 is not valid base64.', true);
      if (bytes.length > AUTOMATION_LIMITS.inlineUploadBytes) {
        return textResult(`Invalid arguments for upload_file: inline content is limited to ${AUTOMATION_LIMITS.inlineUploadBytes / 1024} KiB and this is ${bytes.length} bytes. Pass size (and no content) to get a one-time upload URL instead.`, true);
      }
      if (args.size !== undefined && args.size !== bytes.length) return textResult(`Invalid arguments for upload_file: size is ${args.size} but the content is ${bytes.length} bytes.`, true);
      try {
        const stored = await this.store(rec, { name: args.name, type, size: bytes.length }, oneChunk(bytes));
        return textResult([
          JSON.stringify({ handle: stored.handle, name: stored.name, size: stored.size }),
          `Stored "${stored.name}" (${stored.size} bytes) in the browser's temporary storage. Pass the handle to attach_files.`,
          ...notices,
        ].join('\n'));
      } catch (error) {
        return refusal(error instanceof TransferFailed ? error.reason : 'write_failed', 'The file was not stored.');
      }
    }
    if (args.size === undefined) {
      return textResult('Invalid arguments for upload_file: pass text or base64 for a small file, or size (its exact bytes) for a one-time upload URL.', true);
    }
    const now = Date.now();
    const pending = Object.values(rec.uploads).filter((s) => s.state === 'pending' && s.expiresAt > now).length;
    if (pending >= MAX_UPLOAD_SLOTS) return refusal('too_large', `This session already has ${pending} unused upload URLs; use them or wait until they lapse.`);
    const { slotId, secret } = newSlotSecret();
    const expiresAt = now + AUTOMATION_LIMITS.uploadSlotMs;
    rec.uploads[slotId] = { secretHash: await sha256Hex(secret), name: args.name, size: args.size, mime: type, expiresAt, state: 'pending' };
    await this.save(rec);
    await this.host.scheduleAlarm(expiresAt);
    const url = `${caller.origin}/u/${instanceId}.${slotId}.${secret}`;
    return textResult([uploadInstructions(url, args.name, args.size, expiresAt), ...notices].join('\n'));
  }

  /** Streams one file into the session's temporary area in the VM and records its handle. */
  private store(rec: McpRecord, file: { name: string; type: string; size: number }, source: AsyncIterable<Uint8Array>): Promise<Stored> {
    const run = this.transfers.then(async () => {
      if (this.record !== rec) throw new TransferFailed('session_closed', 502);
      const stored = await storeInVm(this.linkFor(rec), requestId(), file, source);
      rec.handles[stored.handle] = { name: stored.name, size: stored.size };
      rec.lastUsedAt = Date.now();
      await this.save(rec);
      return stored;
    });
    this.transfers = run.catch(() => {});
    return run;
  }

  private async status(caller: Caller, instanceId: string, waitMs: number): Promise<ToolResult> {
    const deadline = Date.now() + waitMs;
    let row = await this.host.readInstance(instanceId);
    // Long poll: woken by the user's hand-back (or any control change), then the row says what is true.
    while (row && controlMode(row) !== 'agent' && Date.now() < deadline) {
      await this.waitForControl(deadline - Date.now());
      row = await this.host.readInstance(instanceId);
    }
    if (row === undefined) return refusal('relay_unavailable', 'The browser\'s state could not be read just now.');
    if (!row || row.user_id !== caller.userId) return refusal('browser_unavailable', 'This browser no longer exists.');
    const online = !!this.host.agent();
    const running = row.status === 'running' && row.desired_state === 'running';
    const lines = [
      `browser: ${row.status}${row.desired_state !== 'running' && row.status === 'running' ? ` (going to ${row.desired_state})` : ''}${running ? '' : ' — ask the user to open it in Nevazu; a coding agent cannot wake it'}`,
      `coding agent access: ${row.agent_access ? 'on' : 'off'}; this key: "${caller.keyName}" (${caller.capability === 'view' ? 'view only' : 'control'})`,
      `browser agent: ${online ? 'online' : 'offline'}`,
      describeControl(this.host.controlState(row)),
    ];
    const rec = await this.load();
    if (rec && rec.clientId === caller.clientId) {
      const now = Date.now();
      rec.lastUsedAt = now;
      await this.save(rec);
      lines.push(
        `session ${rec.sessionId}: open for ${Math.round((now - rec.startedAt) / 60_000)} min; closes after ${AUTOMATION_LIMITS.idleSessionMs / 60_000} min without a call (next at ${new Date(now + AUTOMATION_LIMITS.idleSessionMs).toISOString()}) and at ${new Date(rec.startedAt + AUTOMATION_LIMITS.maxSessionMs).toISOString()} at the latest`,
        `latest screenshot: ${rec.latestShotId ?? 'none yet'}`,
      );
      const handles = Object.entries(rec.handles);
      lines.push(handles.length ? `stored files: ${handles.map(([h, f]) => `${h} (${f.name}, ${f.size} bytes)`).join('; ')}` : 'stored files: none');
      const uploads = Object.values(rec.uploads).filter((s) => s.state === 'pending' && s.expiresAt > now);
      if (uploads.length) lines.push(`upload URLs not used yet: ${uploads.map((s) => `${s.name} (${s.size} bytes, until ${new Date(s.expiresAt).toISOString()})`).join('; ')}`);
      if (online && running) {
        const answer = await this.linkFor(rec).request({ t: 'status', id: requestId() }, STATUS_TIMEOUT_MS).catch(() => null);
        if (answer) {
          const { result } = answer;
          if (result.capabilities) {
            rec.vmProtocol = result.capabilities.protocol;
            const c = result.capabilities;
            lines.push(`capabilities: protocol ${c.protocol}, screenshots ${c.screenshot ? 'yes' : 'no'}, files ${c.files ? 'yes' : 'no'} (picker ${c.picker ? 'yes' : 'no'}, paste ${c.paste ? 'yes' : 'no'}, drop ${c.drop ? 'yes' : 'no'})`);
          }
          lines.push(describeScreen(result.screen));
          if (result.reason) lines.push(`browser session: ${result.reason}`);
          if (result.activeActionId) lines.push('an act is running now');
        }
      }
    } else if (rec) {
      const idleMs = Date.now() - rec.lastUsedAt;
      lines.push(`session: another key ("${rec.keyName}"${rec.clientName ? `, ${rec.clientName}` : ''}) holds it, last used ${Math.round(idleMs / 1000)} s ago${idleMs >= BUSY_OTHER_AGENT_MS ? '; your next screenshot or act takes it over' : `; it can be taken over after ${BUSY_OTHER_AGENT_MS / 1000} s without use`}`);
    } else {
      lines.push('session: none open; the next screenshot or act opens one');
    }
    return textResult(lines.join('\n'));
  }

  private async endSession(caller: Caller): Promise<ToolResult> {
    const rec = await this.load();
    if (!rec || rec.clientId !== caller.clientId) return textResult('No session of this key is open; there is nothing to end.');
    const files = Object.keys(rec.handles).length;
    await this.close('ended');
    return textResult(`Session ended${files ? `; ${files} stored file${files > 1 ? 's were' : ' was'} removed` : ''}. The browser is left to the user; the next call opens a new session.`);
  }

  // --- upload URLs --------------------------------------------------------------------------

  /**
   * `PUT /u/<token>`: the file for an upload URL, streamed into the VM as it arrives. The slot is
   * claimed before the first byte is read, so a second request for the same URL gets 409; a lapsed
   * one gets 410. The VM acknowledges every chunk and only a few are ever unacknowledged, so the
   * transfer holds up nothing else on the tunnel.
   */
  private async upload(req: Request, instanceId: string): Promise<Response> {
    const slotId = req.headers.get('x-cb-slot') ?? '';
    const secretHash = await sha256Hex(req.headers.get('x-cb-secret') ?? '');
    const length = Number(req.headers.get('content-length'));
    const rec = await this.load();
    const slot = rec?.uploads[slotId];
    // Everything from here to the claim is synchronous: two requests cannot both claim the slot.
    if (!rec || !slot || !sameDigest(secretHash, slot.secretHash)) {
      return uploadError(404, 'unknown_url', 'This upload URL is not valid, or its session has ended. Call upload_file again.');
    }
    if (slot.state !== 'pending') return uploadError(409, 'already_used', 'This upload URL was already used. Call upload_file again for a new one.');
    if (slot.expiresAt <= Date.now()) return uploadError(410, 'expired', 'This upload URL has expired. Call upload_file again for a new one.');
    if (!Number.isSafeInteger(length) || length !== slot.size) {
      return uploadError(400, 'length_mismatch', `This upload URL takes exactly ${slot.size} bytes; the request has ${length}. Call upload_file again with the file's exact size.`);
    }
    slot.state = 'uploading';
    await this.save(rec);

    const row = await this.host.readInstance(instanceId);
    const refused = row === undefined ? 'relay_unavailable'
      : !row || row.user_id !== rec.userId || row.status !== 'running' || row.desired_state !== 'running' ? 'browser_unavailable'
        : !row.agent_access ? 'agent_access_off'
          : controlMode(row) !== 'agent' ? (controlMode(row) === 'privacy' ? 'control_privacy' : 'control_user')
            : null;
    const lease = refused || !row ? null : await this.checkLease(instanceId, row, rec.sessionId);
    if (refused || lease !== 'ok') {
      // Nothing was read: the URL can be used again once the browser can take the file.
      if (this.record === rec) slot.state = 'pending';
      await this.save(rec);
      const reason = refused ?? (lease === 'billing_denied' ? 'browser_unavailable' : 'relay_unavailable');
      return uploadError(reason === 'relay_unavailable' ? 503 : 403, reason, 'The browser cannot take the file now; see get_status. The URL stays valid until it expires.');
    }
    try {
      const stored = await this.store(rec, { name: slot.name, type: slot.mime, size: slot.size }, streamBytes(req.body ?? new ReadableStream()));
      slot.state = 'done';
      await this.save(rec);
      connectionLog('mcp_upload_stored', { instanceId, sessionId: rec.sessionId, role: 'mcp' });
      return new Response(`${JSON.stringify(stored)}\n`, { status: 200, headers: { 'content-type': 'application/json' } });
    } catch (error) {
      slot.state = 'failed';
      await this.save(rec);
      const failure = error instanceof TransferFailed ? error : new TransferFailed('write_failed', 502);
      connectionLog('mcp_upload_failed', { instanceId, sessionId: rec.sessionId, role: 'mcp', code: failure.reason });
      return uploadError(failure.status, failure.reason, failure.status === 502
        ? 'The browser did not store the file. Call upload_file again for a new URL.'
        : 'The upload did not arrive complete. Call upload_file again for a new URL.');
    }
  }
}
