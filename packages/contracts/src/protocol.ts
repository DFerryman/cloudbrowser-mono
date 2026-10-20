import { z } from 'zod';

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

export const AgentHello = z.object({
  t: z.literal('hello'),
  agentVersion: z.string(),
  generation: z.number().int(),
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

/** How a file transfer is going, for the viewer that sent it (agent 0.3.0). */
export const AgentViewerFile = z.object({
  t: z.literal('viewer_file'), sessionId: z.string(), relayId: z.string().optional(),
  id: z.string().max(64),
  /** progress: `received` bytes are on the VM; done: pasted (clipboard ready) or dropped. */
  status: z.enum(['progress', 'done', 'error']),
  received: z.number().int().nonnegative().optional(),
  reason: z.string().max(64).optional(),
});

export const AgentFrame = z.discriminatedUnion('t', [AgentHello, AgentEvent, AgentReply, AgentTurnRequest, AgentToViewer, AgentViewerError, AgentViewerFile]);
export type AgentFrame = z.infer<typeof AgentFrame>;

// --- gateway -> agent -----------------------------------------------------------------------

export type GatewayToAgent =
  /** Sent once after a bootstrap exchange: the long-lived credential to store (mode 0600). */
  | { t: 'welcome'; credential?: string }
  | { t: 'command'; id: string; kind: AgentCommandKind; payload: Record<string, unknown> }
  | { t: 'turn'; iceServers: IceServer[] }
  | { t: 'viewer_open'; sessionId: string; relayId?: string }
  /** A frame from the viewer: a neko message or IME text. */
  | { t: 'viewer'; sessionId: string; relayId?: string; data: ViewerFrame }
  | { t: 'viewer_close'; sessionId: string; relayId?: string };

// --- viewer <-> gateway ---------------------------------------------------------------------

/**
 * Files a viewer pasted or dropped. They travel to the VM as ordered base64 chunks on the viewer
 * socket, each file's bytes in order; the agent acknowledges what it wrote, and the viewer keeps
 * only a few chunks unacknowledged so the gateway's input queue never fills.
 */
export const FILE_TRANSFER = {
  maxFiles: 10,
  maxBytes: 50 * 1024 * 1024,
  chunkBytes: 96 * 1024,
  /** Chunks sent ahead of the agent's acknowledgement. */
  window: 3,
} as const;
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
  /** Input could not be delivered; stop and require an explicit reconnect, never replay it. */
  | { t: 'input_error'; reason: string }
  | { t: 'agent_online' }
  | { t: 'agent_offline' }
  /** Another tab or device opened this browser (one controller at a time). */
  | { t: 'taken_over' }
  | { t: 'file'; id: string; status: 'progress' | 'done' | 'error'; received?: number; reason?: string };

/** Claims of the single-use viewer token (Ed25519, 60 s, page 2). */
export const ViewerTokenClaims = z.object({
  jti: z.string(),
  sid: z.string(),
  iid: z.string(),
  uid: z.string(),
  exp: z.number().int(),
});
export type ViewerTokenClaims = z.infer<typeof ViewerTokenClaims>;
