import { z } from 'zod';
import { AgentControlMode, AutomationRequest, AutomationResponse, ControlState } from './automation.js';
import { FILE_TRANSFER } from './transfer.js';

/**
 * Wire protocol between the in-VM agent, the session gateway and the viewer (page 2, "Contracts").
 *
 * The plan names protobuf for `agent.v1` / `viewer.v1`. These are JSON text frames instead: the
 * gateway runs on Cloudflare Durable Objects (TypeScript), and the payload it relays most, neko v3
 * signaling, is JSON already. Every frame carries `t` (type); the version is in the URL path
 * (`/v1/agent`, `/v1/stream/:instanceId`). `services/agent/protocol.go` mirrors these types.
 */

export const AGENT_PROTOCOL_VERSION = 1;

/** Commands the engine sends to an agent (stored in `agent_commands`). */
export const AgentCommandKind = z.enum(['prepare_shutdown', 'ip_check', 'restart_chrome', 'set_firewall', 'restore_archive', 'grow_filesystem']);
export type AgentCommandKind = z.infer<typeof AgentCommandKind>;

/** Events an agent reports (stored by the api in `instance_health` and `audit_log`). */
export const AgentEventKind = z.enum(['ready', 'heartbeat', 'ip_check', 'chrome_exited']);
/** Why the VM changed who may drive the browser (control_state frames). */
export const ControlChangeReason = z.enum(['user_input', 'resumed', 'paused', 'privacy', 'released', 'revoked', 'restored', 'agent_input']);
export type ControlChangeReason = z.infer<typeof ControlChangeReason>;
export type AgentEventKind = z.infer<typeof AgentEventKind>;

export const IpCheckResult = z.object({
  ok: z.boolean(),
  expected: z.string().nullable().optional(),
  observed: z.array(z.string()),
  detail: z.string().optional(),
});
export type IpCheckResult = z.infer<typeof IpCheckResult>;

export const IceServer = z.object({
  urls: z.array(z.string()),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServer = z.infer<typeof IceServer>;

// --- agent -> gateway -----------------------------------------------------------------------

/**
 * Why the VM's previous tunnel ended, as the VM saw it (agent 0.6.0), sent in the next hello so
 * the gateway's logs explain a drop without the VM's journal. Fixed codes only, never error text.
 */
export const AgentTunnelEnd = z.object({
  /**
   * silent: nothing arrived within the keepalive window; closed: a close frame (`closeCode`);
   * write_timeout: a frame could not be sent within 10 s; reset, eof, timeout, error: the
   * connection failed under it.
   */
  reason: z.enum(['silent', 'closed', 'write_timeout', 'reset', 'eof', 'timeout', 'error']),
  closeCode: z.number().int().min(1000).max(4999).optional(),
  /** How long that tunnel was up, and how long the VM was without one. */
  upMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  downMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  /** Dials that failed in between, and how the last one failed: dns, connect, tls, timeout, http_<status> or error. */
  dialFailures: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  dialError: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/).optional(),
});
export type AgentTunnelEnd = z.infer<typeof AgentTunnelEnd>;

export const AgentHello = z.object({
  t: z.literal('hello'),
  agentVersion: z.string(),
  generation: z.number().int(),
  /** A report the gateway cannot read is dropped: it must never refuse the tunnel. */
  previous: AgentTunnelEnd.optional().catch(undefined),
});
export const AgentEvent = z.object({
  t: z.literal('event'),
  kind: AgentEventKind,
  /** ready: { chromeMajor, agentVersion }, heartbeat: { viewers, lastInputAt, disk: { usedBytes, totalBytes }, netTxBytes }, ip_check: IpCheckResult */
  data: z.record(z.string(), z.unknown()).default({}),
});
export const AgentReply = z.object({
  t: z.literal('reply'),
  commandId: z.string(),
  ok: z.boolean(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
});
export const AgentTurnRequest = z.object({ t: z.literal('turn_request') });
/** A neko message for one viewer session. */
export const AgentToViewer = z.object({ t: z.literal('viewer'), sessionId: z.string(), relayId: z.string().optional(), data: z.unknown() });
export const AgentViewerError = z.object({
  t: z.literal('viewer_error'), sessionId: z.string(), relayId: z.string().optional(),
  reason: z.enum(['relay_unavailable', 'relay_failed', 'input_failed']),
});

/** Safe milestones only: never include a local URL, token, SDP or viewer input. */
export const AgentViewerStageName = z.enum([
  'received', 'login_start', 'login_ok', 'websocket_start', 'websocket_open',
  'desktop_ready', 'failed', 'closed',
]);
export const AgentViewerFailureCode = z.enum([
  'login_timeout', 'login_rejected', 'login_unavailable', 'websocket_timeout',
  'websocket_unavailable', 'desktop_timeout', 'canceled', 'relay_unavailable',
]);
export const AgentViewerStage = z.object({
  t: z.literal('viewer_stage'), sessionId: z.string().max(128), relayId: z.string().max(64).optional(),
  stage: AgentViewerStageName,
  elapsedMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  code: AgentViewerFailureCode.optional(),
});
export type AgentViewerStage = z.infer<typeof AgentViewerStage>;

/** How a file transfer is going, for the viewer that sent it (agent 0.3.0). */
export const AgentViewerFile = z.object({
  t: z.literal('viewer_file'), sessionId: z.string(), relayId: z.string().optional(),
  id: z.string().max(64),
  /** progress: `received` bytes are on the VM; done: pasted (clipboard ready) or dropped. */
  status: z.enum(['progress', 'done', 'error']),
  received: z.number().int().nonnegative().optional(),
  reason: z.string().max(64).optional(),
});

/** A response for one coding-agent session (docs/agent-access.md); blobs are the screenshot bytes. */
export const AgentAutomationResult = z.object({ t: z.literal('automation_result'), sessionId: z.string().max(128), data: AutomationResponse });
/**
 * The VM changed who may drive the browser. The gateway fans it out to viewers and the coding
 * agent's session, and the api persists the mode (`browser_instances.agent_control`) and audits the change.
 */
export const AgentControlState = z.object({ t: z.literal('control_state'), control: ControlState, reason: ControlChangeReason });
export type AgentControlState = z.infer<typeof AgentControlState>;

export const AgentFrame = z.discriminatedUnion('t', [AgentHello, AgentEvent, AgentReply, AgentTurnRequest, AgentToViewer, AgentViewerError, AgentViewerFile, AgentViewerStage, AgentAutomationResult, AgentControlState]);
export type AgentFrame = z.infer<typeof AgentFrame>;

// --- gateway -> agent -----------------------------------------------------------------------

export type GatewayToAgent =
  /**
   * Sent once after a bootstrap exchange: the long-lived credential to store (mode 0600).
   * `automation` carries the persisted control mode, so a takeover survives agent restarts.
   * `keepalive`: the gateway answers `{"t":"ping"}` with `{"t":"pong"}` on this tunnel.
   */
  | { t: 'welcome'; credential?: string; viewerStages?: boolean; keepalive?: boolean; automation?: { mode: AgentControlMode; access: boolean } }
  | { t: 'command'; id: string; kind: AgentCommandKind; payload: Record<string, unknown> }
  | { t: 'turn'; iceServers: IceServer[] }
  | { t: 'viewer_open'; sessionId: string; relayId?: string }
  /** A frame from the viewer: a neko message or IME text. */
  | { t: 'viewer'; sessionId: string; relayId?: string; data: ViewerFrame }
  | { t: 'viewer_close'; sessionId: string; relayId?: string }
  /**
   * A coding agent's session (docs/agent-access.md): opened, a request, closed. Protocol 2 VMs treat
   * a repeated open of the same session id (after a tunnel reconnect) as a resume.
   */
  | { t: 'automation_open'; sessionId: string; clientId: string }
  | { t: 'automation'; sessionId: string; data: AutomationRequest }
  | { t: 'automation_close'; sessionId: string }
  /** The user's choice from the api: hand control back (`agent`), pause (`user`) or privacy pause. */
  | { t: 'automation_control'; mode: AgentControlMode; access: boolean };

// --- viewer <-> gateway ---------------------------------------------------------------------

export { FILE_TRANSFER } from './transfer.js';
const TransferId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const ViewerFrame = z.discriminatedUnion('t', [
  /** A neko v3 message, relayed as-is to neko through the agent. */
  z.object({ t: z.literal('neko'), data: z.unknown() }),
  /** Final IME / composed text, inserted by the agent with CDP Input.insertText (page 5). */
  z.object({ t: z.literal('ime'), text: z.string().max(10_000) }),
  /**
   * paste: put the files on the remote clipboard (one PNG as an image, otherwise as files) for a
   * Ctrl+V the viewer sends after `done`. drop: drop them on the page at x/y (remote pixels).
   */
  z.object({
    t: z.literal('file_begin'), id: TransferId, action: z.enum(['paste', 'drop']),
    x: z.number().int().min(0).max(0xffff).optional(), y: z.number().int().min(0).max(0xffff).optional(),
    files: z.array(z.object({
      name: z.string().min(1).max(255), type: z.string().max(255),
      size: z.number().int().nonnegative().max(FILE_TRANSFER.maxBytes),
    })).min(1).max(FILE_TRANSFER.maxFiles),
  }),
  z.object({
    t: z.literal('file_chunk'), id: TransferId, file: z.number().int().min(0).max(FILE_TRANSFER.maxFiles - 1),
    chunk: z.string().max(Math.ceil(FILE_TRANSFER.chunkBytes / 3) * 4),
  }),
  z.object({ t: z.literal('file_end'), id: TransferId }),
  z.object({ t: z.literal('file_cancel'), id: TransferId }),
]);
export type ViewerFrame = z.infer<typeof ViewerFrame>;

export type GatewayToViewer =
  | { t: 'neko'; data: unknown }
  /** The runtime's answer to the viewer's `{"t":"ping"}` (setWebSocketAutoResponse), in order after everything the gateway received before it. */
  | { t: 'pong' }
  /** Input could not be delivered; stop and require an explicit reconnect, never replay it. */
  | { t: 'input_error'; reason: string }
  | { t: 'agent_online' }
  | { t: 'agent_offline' }
  | { t: 'connection_stage'; stage: 'gateway_accepted' | AgentViewerStage['stage']; relayId?: string; code?: AgentViewerStage['code'] }
  /** Another tab or device opened this browser (one controller at a time). */
  | { t: 'taken_over' }
  | { t: 'file'; id: string; status: 'progress' | 'done' | 'error'; received?: number; reason?: string }
  /** A coding agent's session is open (or not) and who may drive the browser (docs/agent-access.md). */
  | { t: 'automation_status'; connected: boolean; control: ControlState };

/** Claims of the single-use viewer token (Ed25519, 60 s, page 2). */
export const ViewerTokenClaims = z.object({
  jti: z.string(),
  sid: z.string(),
  iid: z.string(),
  uid: z.string(),
  exp: z.number().int(),
});
export type ViewerTokenClaims = z.infer<typeof ViewerTokenClaims>;
