import { z } from 'zod';
import { FILE_TRANSFER } from './transfer.js';

/**
 * Coding-agent access (docs/agent-access.md): a local bridge, paired by the browser's owner,
 * connects to the session gateway on `/v1/automation/:instanceId` and drives the same Chrome,
 * profile and desktop the live view shows. The agent inside the VM arbitrates input between the
 * bridge and the viewer; this module is the wire contract on the bridge side of the gateway and,
 * mirrored in `services/agent/internal/protocol`, between the gateway and the VM.
 */

export const AUTOMATION_PROTOCOL_VERSION = 1;

/**
 * Who may drive the browser (`browser_instances.agent_control`, owner: api and the VM):
 *  - `agent`: a connected bridge may hold input control.
 *  - `user`: the user took over with a real input; input from the bridge is refused until the
 *    user explicitly hands control back (Settings or the live view). Reconnects never clear it.
 *  - `privacy`: as `user`, and no screenshot is delivered to the bridge either.
 */
export const AgentControlMode = z.enum(['agent', 'user', 'privacy']);
export type AgentControlMode = z.infer<typeof AgentControlMode>;

/** Who holds input in the VM right now. `none` until a bridge acts or the user touches the view. */
export const Controller = z.enum(['none', 'agent', 'user']);
export type Controller = z.infer<typeof Controller>;

export const AUTOMATION_LIMITS = {
  /** Steps in one `act` call, executed in order inside the VM. */
  maxSteps: 32,
  /** One `act` call, including its bounded waits, from the first input to the screenshot. */
  maxActMs: 30_000,
  /** One `wait` step. */
  maxWaitMs: 5_000,
  /** Points in a drag path. */
  maxDragPoints: 64,
  /** Keys in one chord. */
  maxChordKeys: 6,
  /** `type` text per step. */
  maxTypeChars: 4_000,
  /** Screenshots are refused closer together than this. */
  minScreenshotIntervalMs: 150,
  /** Base64 payload of one blob frame; the frame stays under the gateway's 256 KiB limit. */
  blobChunkChars: 160 * 1024,
  /** A bridge session ends after this long; the bridge reconnects for a new one. */
  maxSessionMs: 8 * 3600_000,
  /** A pairing code's lifetime. */
  pairingCodeMs: 10 * 60_000,
  /** Files held in the VM's temporary store per session (same bound as viewer transfers). */
  maxStoredBytes: FILE_TRANSFER.maxBytes,
} as const;

const Coord = z.number().int().min(0).max(0xffff);
const Point = z.object({ x: Coord, y: Coord });
/** Key names as in packages/viewer/src/keyboard.ts (`Control`, `Enter`, `a`, `F5`…) or `keysym:0xff0d`. */
const KeyName = z.string().min(1).max(32);
const Modifiers = z.array(z.enum(['Shift', 'Control', 'Alt', 'Meta'])).max(4).optional();
export const MouseButton = z.enum(['left', 'middle', 'right', 'back', 'forward']);
export type MouseButton = z.infer<typeof MouseButton>;

/** One input step of an `act` call. Coordinates are remote screen pixels of the referenced screenshot. */
export const ActionStep = z.discriminatedUnion('type', [
  z.object({ type: z.literal('move'), x: Coord, y: Coord }),
  /** Clicks `count` times (double-click: 2) at the point, with `modifiers` held. */
  z.object({ type: z.literal('click'), x: Coord.optional(), y: Coord.optional(), button: MouseButton.default('left'), count: z.number().int().min(1).max(3).default(1), modifiers: Modifiers }),
  /** Holds or releases a button, for drags the `drag` step cannot express. */
  z.object({ type: z.literal('button'), x: Coord.optional(), y: Coord.optional(), button: MouseButton.default('left'), down: z.boolean() }),
  /** Presses at the first point, moves through the rest, releases at the last. */
  z.object({ type: z.literal('drag'), path: z.array(Point).min(2).max(AUTOMATION_LIMITS.maxDragPoints), button: MouseButton.default('left'), modifiers: Modifiers }),
  /** Wheel ticks: positive `deltaY` scrolls down, positive `deltaX` right. Control held zooms. */
  z.object({ type: z.literal('scroll'), x: Coord.optional(), y: Coord.optional(), deltaX: z.number().int().min(-100).max(100).default(0), deltaY: z.number().int().min(-100).max(100).default(0), modifiers: Modifiers }),
  /** A chord: every key is pressed in order and released in reverse (`['Control', 'l']`). */
  z.object({ type: z.literal('key'), keys: z.array(KeyName).min(1).max(AUTOMATION_LIMITS.maxChordKeys) }),
  /** Holds (`down`) or releases a single key, e.g. Shift across several clicks. */
  z.object({ type: z.literal('keyhold'), key: KeyName, down: z.boolean() }),
  /** Types text into whatever has focus; never appends Enter. Non-ASCII text is typed via the remote clipboard. */
  z.object({ type: z.literal('type'), text: z.string().min(1).max(AUTOMATION_LIMITS.maxTypeChars) }),
  /** Puts text on the remote clipboard and pastes it (Ctrl+V). */
  z.object({ type: z.literal('paste'), text: z.string().min(1).max(AUTOMATION_LIMITS.maxTypeChars) }),
  z.object({ type: z.literal('wait'), ms: z.number().int().min(0).max(AUTOMATION_LIMITS.maxWaitMs) }),
]);
export type ActionStep = z.infer<typeof ActionStep>;

const RequestId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const Handle = z.string().regex(/^[A-Za-z0-9_-]{1,96}$/);
const Quality = z.number().int().min(10).max(100).optional();

/**
 * A coordinate-based request names the screenshot it was decided on. The VM refuses it when the
 * screen geometry (`screenVersion`) or control (`controlEpoch`) changed since.
 */
const Basis = {
  screenshotId: z.string().max(64).optional(),
  screenVersion: z.number().int().nonnegative().optional(),
  controlEpoch: z.number().int().nonnegative().optional(),
};

/** Bridge → gateway → VM. */
export const AutomationRequest = z.discriminatedUnion('t', [
  z.object({ t: z.literal('screenshot'), id: RequestId, quality: Quality }),
  z.object({
    t: z.literal('act'), id: RequestId, ...Basis,
    steps: z.array(ActionStep).min(1).max(AUTOMATION_LIMITS.maxSteps),
    /** Wait this long after the last step before the screenshot (default 400 ms). */
    settleMs: z.number().int().min(0).max(AUTOMATION_LIMITS.maxWaitMs).optional(),
    /** Return a screenshot with the result (default true). */
    screenshot: z.boolean().optional(),
    quality: Quality,
  }),
  z.object({ t: z.literal('status'), id: RequestId }),
  /** Stops the running `act` (its remaining steps); input already dispatched stays. */
  z.object({ t: z.literal('cancel'), id: RequestId, actionId: RequestId }),
  /**
   * Files travel like a viewer's (FILE_TRANSFER): `store` keeps them in the session's temporary
   * area and answers with handles; nothing touches the page until `attach`.
   */
  z.object({
    t: z.literal('file_begin'), id: RequestId, action: z.literal('store'),
    files: z.array(z.object({
      name: z.string().min(1).max(255), type: z.string().max(255),
      size: z.number().int().nonnegative().max(FILE_TRANSFER.maxBytes),
    })).min(1).max(FILE_TRANSFER.maxFiles),
  }),
  z.object({ t: z.literal('file_chunk'), id: RequestId, file: z.number().int().min(0).max(FILE_TRANSFER.maxFiles - 1), chunk: z.string().max(Math.ceil(FILE_TRANSFER.chunkBytes / 3) * 4) }),
  z.object({ t: z.literal('file_end'), id: RequestId }),
  z.object({ t: z.literal('file_cancel'), id: RequestId }),
  /**
   * Delivers stored files to the page: `picker` into Chrome's open file dialog, `paste` onto the
   * clipboard followed by Ctrl+V, `drop` onto the page at a point. Needs input control now.
   */
  z.object({
    t: z.literal('attach'), id: RequestId, ...Basis,
    handles: z.array(Handle).min(1).max(FILE_TRANSFER.maxFiles),
    method: z.enum(['picker', 'paste', 'drop']),
    x: Coord.optional(), y: Coord.optional(),
    screenshot: z.boolean().optional(), quality: Quality,
  }),
]);
export type AutomationRequest = z.infer<typeof AutomationRequest>;

export const ActionStatus = z.enum(['executed', 'rejected', 'interrupted', 'timeout', 'error']);
export type ActionStatus = z.infer<typeof ActionStatus>;

/** Why a request did not execute (`reason` of a rejected result). */
export const RejectReason = z.enum([
  'control_user', 'control_privacy', 'agent_access_off', 'screen_changed', 'control_changed',
  'busy', 'invalid', 'unsupported', 'desktop_unavailable', 'not_on_page', 'no_dialog',
  'too_fast', 'not_found', 'too_large', 'write_failed', 'relay_unavailable',
]);
export type RejectReason = z.infer<typeof RejectReason>;

export const ScreenInfo = z.object({ version: z.number().int().nonnegative(), width: z.number().int().nonnegative(), height: z.number().int().nonnegative() });
export type ScreenInfo = z.infer<typeof ScreenInfo>;

export const ScreenshotMeta = z.object({
  id: z.string().max(64),
  /** The `blob` frames carrying the image bytes precede the result that names them. */
  blobId: z.string().max(64),
  mime: z.literal('image/jpeg'),
  bytes: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  capturedAt: z.string(),
  screenVersion: z.number().int().nonnegative(),
  controlEpoch: z.number().int().nonnegative(),
});
export type ScreenshotMeta = z.infer<typeof ScreenshotMeta>;

export const ControlState = z.object({
  controller: Controller,
  mode: AgentControlMode,
  epoch: z.number().int().nonnegative(),
});
export type ControlState = z.infer<typeof ControlState>;

export const AutomationCapabilities = z.object({
  protocol: z.number().int(),
  agentVersion: z.string().max(32),
  screenshot: z.boolean(),
  files: z.boolean(),
  picker: z.boolean(),
  paste: z.boolean(),
  drop: z.boolean(),
  touch: z.literal(false),
});
export type AutomationCapabilities = z.infer<typeof AutomationCapabilities>;

/** VM → gateway → bridge. */
export const AutomationResponse = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('result'), id: RequestId,
    kind: z.enum(['screenshot', 'act', 'status', 'attach', 'cancel']),
    status: ActionStatus,
    reason: z.string().max(64).optional(),
    /** Index of the step that did not run (interrupted or timed out), if any. */
    stoppedAt: z.number().int().nonnegative().optional(),
    control: ControlState,
    screen: ScreenInfo,
    screenshot: ScreenshotMeta.optional(),
    capabilities: AutomationCapabilities.optional(),
    /** The running `act`, for `status`. */
    activeActionId: z.string().max(64).optional(),
  }),
  z.object({ t: z.literal('blob'), id: z.string().max(64), seq: z.number().int().nonnegative(), last: z.boolean(), data: z.string().max(AUTOMATION_LIMITS.blobChunkChars) }),
  z.object({
    t: z.literal('file'), id: RequestId, status: z.enum(['progress', 'done', 'error']),
    received: z.number().int().nonnegative().optional(), reason: z.string().max(64).optional(),
    handles: z.array(z.object({ handle: Handle, name: z.string(), size: z.number().int().nonnegative(), type: z.string() })).optional(),
  }),
  /** Pushed whenever control or the mode changes. */
  z.object({ t: z.literal('control'), control: ControlState, reason: z.string().max(64) }),
  /** Pushed whenever the remote screen changes size; earlier screenshots' coordinates are void. */
  z.object({ t: z.literal('screen'), screen: ScreenInfo }),
]);
export type AutomationResponse = z.infer<typeof AutomationResponse>;

/** Gateway → bridge, besides relayed `AutomationResponse` frames. */
export type GatewayToAutomation =
  | AutomationResponse
  | { t: 'welcome'; sessionId: string; instanceId: string; clientId: string; protocol: number; mode: AgentControlMode }
  | { t: 'agent_online' }
  | { t: 'agent_offline' }
  /** The gateway refused a request before the VM saw it (lease, mode or privacy). */
  | { t: 'refused'; id: string; reason: RejectReason }
  | { t: 'revoked'; reason: 'access_off' | 'client_revoked' | 'session_expired' | 'browser_unavailable' };

// --- api: pairing and status ------------------------------------------------------------------

export const AutomationClientName = z.string().trim().min(1).max(64);

export const AutomationClient = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  /** Null until the bridge redeemed its pairing code. */
  activatedAt: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  /** The pairing code expires unused at this time; null once redeemed. */
  pairingExpiresAt: z.string().nullable(),
});
export type AutomationClient = z.infer<typeof AutomationClient>;

export const AutomationStatus = z.object({
  /** The owner's setting: whether coding agents may connect at all. */
  enabled: z.boolean(),
  mode: AgentControlMode,
  clients: z.array(AutomationClient),
  /** The bridge session connected now, if any. */
  session: z.object({ id: z.string(), clientId: z.string(), startedAt: z.string(), lastSeenAt: z.string() }).nullable(),
});
export type AutomationStatus = z.infer<typeof AutomationStatus>;

export const CreatePairingBody = z.object({ name: AutomationClientName });
export const Pairing = z.object({
  clientId: z.string(),
  /** Shown once; the bridge redeems it with `POST /api/automation/pair`. */
  code: z.string(),
  expiresAt: z.string(),
  /** What to run locally. */
  command: z.string(),
});
export type Pairing = z.infer<typeof Pairing>;

export const SetControlBody = z.object({ mode: AgentControlMode });

/** The bridge's redemption of a pairing code (no user session; the code is the proof). */
export const RedeemPairingBody = z.object({
  code: z.string().trim().min(8).max(64),
  /** The bridge's own description of the machine it runs on, shown to the user. */
  client: z.string().trim().max(120).optional(),
});
export const PairingGrant = z.object({
  clientId: z.string(),
  instanceId: z.string(),
  instanceName: z.string(),
  /** Long-lived bearer credential for the gateway; only its hash is stored. */
  credential: z.string(),
  gatewayUrl: z.string(),
  protocol: z.number().int(),
});
export type PairingGrant = z.infer<typeof PairingGrant>;
