import { z } from 'zod';
import { FILE_TRANSFER } from './transfer.js';

/**
 * Coding-agent access (docs/agent-access.md): a coding agent adds the session gateway's remote MCP
 * endpoint (`POST /mcp/:instanceId` on the gateway's host) with a per-browser access key and drives
 * the same Chrome, profile and desktop the live view shows. The browser's Durable Object holds the
 * agent's session and speaks this protocol to the VM, where the agent arbitrates input between the
 * coding agent and the viewer. This module is the wire contract between the gateway and the VM
 * (mirrored in `services/agent/internal/protocol`) and the api's key and status shapes.
 */

/**
 * 2: screenshots can be scaled to fit (`maxWidth`/`maxHeight`, with the native size in the meta),
 * `automation_open` is idempotent and a session survives a short tunnel gap, requests wait for the
 * desktop to be ready. Every addition is optional, so a protocol 1 VM keeps working.
 */
export const AUTOMATION_PROTOCOL_VERSION = 2;

/**
 * Who may drive the browser (`browser_instances.agent_control`, owner: api and the VM):
 *  - `agent`: a connected coding agent may hold input control.
 *  - `user`: the user took over with a real input; input from the agent is refused until the
 *    user explicitly hands control back (Settings or the live view). Reconnects never clear it.
 *  - `privacy`: as `user`, and no screenshot is delivered to the agent either.
 */
export const AgentControlMode = z.enum(['agent', 'user', 'privacy']);
export type AgentControlMode = z.infer<typeof AgentControlMode>;

/** Who holds input in the VM right now. `none` until an agent acts or the user touches the view. */
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
  /** A session ends after this long at the latest; the agent's next call opens a new one. */
  maxSessionMs: 8 * 3600_000,
  /** A session nobody used for this long is closed (its stored files with it). */
  idleSessionMs: 15 * 60_000,
  /** A VM keeps a session (and its stored files) this long across a tunnel reconnect (protocol 2). */
  resumeGraceMs: 60_000,
  /** How long a request may wait for the desktop session to become ready. */
  readinessMs: 15_000,
  /** Files held in the VM's temporary store per session (same bound as viewer transfers). */
  maxStoredBytes: FILE_TRANSFER.maxBytes,
  /** Content an agent may send inline with `upload_file`; larger files use a one-time upload URL. */
  inlineUploadBytes: 512 * 1024,
  /** A one-time upload URL's lifetime. */
  uploadSlotMs: 10 * 60_000,
  /** Screenshot bounds of `size: 'fit'`: what coding agents' vision models read without resampling. */
  fitWidth: 1280,
  fitHeight: 800,
} as const;

const Coord = z.number().int().min(0).max(0xffff);
const Point = z.object({ x: Coord, y: Coord });
/** Key names as in packages/viewer/src/keyboard.ts (`Control`, `Enter`, `a`, `F5`…) or `keysym:0xff0d`. */
const KeyName = z.string().min(1).max(32);
const Modifiers = z.array(z.enum(['Shift', 'Control', 'Alt', 'Meta'])).max(4).optional();
export const MouseButton = z.enum(['left', 'middle', 'right', 'back', 'forward']);
export type MouseButton = z.infer<typeof MouseButton>;

/** One input step of an `act` call. Coordinates are remote screen pixels (the gateway maps them from the screenshot image). */
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
 * Protocol 2: the VM scales the screenshot to fit these bounds (aspect kept, never enlarged) and
 * reports the native size next to the image size. A protocol 1 VM ignores them.
 */
const ShotBounds = {
  maxWidth: z.number().int().min(320).max(4096).optional(),
  maxHeight: z.number().int().min(320).max(4096).optional(),
};

/**
 * A coordinate-based request names the screenshot it was decided on. The VM refuses it when the
 * screen geometry (`screenVersion`) or control (`controlEpoch`) changed since.
 */
const Basis = {
  screenshotId: z.string().max(64).optional(),
  screenVersion: z.number().int().nonnegative().optional(),
  controlEpoch: z.number().int().nonnegative().optional(),
};

/** Gateway → VM, for one coding-agent session. */
export const AutomationRequest = z.discriminatedUnion('t', [
  z.object({ t: z.literal('screenshot'), id: RequestId, quality: Quality, ...ShotBounds }),
  z.object({
    t: z.literal('act'), id: RequestId, ...Basis,
    steps: z.array(ActionStep).min(1).max(AUTOMATION_LIMITS.maxSteps),
    /** Wait this long after the last step before the screenshot (default 400 ms). */
    settleMs: z.number().int().min(0).max(AUTOMATION_LIMITS.maxWaitMs).optional(),
    /** Return a screenshot with the result (default true). */
    screenshot: z.boolean().optional(),
    quality: Quality, ...ShotBounds,
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
    screenshot: z.boolean().optional(), quality: Quality, ...ShotBounds,
  }),
]);
export type AutomationRequest = z.infer<typeof AutomationRequest>;

export const ActionStatus = z.enum(['executed', 'rejected', 'interrupted', 'timeout', 'error']);
export type ActionStatus = z.infer<typeof ActionStatus>;

/**
 * Why a request did not execute (`reason` of a rejected result). The last four never come from
 * the VM: the gateway refuses with them before a request reaches it.
 */
export const RejectReason = z.enum([
  'control_user', 'control_privacy', 'agent_access_off', 'screen_changed', 'control_changed',
  'busy', 'invalid', 'unsupported', 'desktop_unavailable', 'not_on_page', 'no_dialog',
  'too_fast', 'not_found', 'too_large', 'write_failed', 'relay_unavailable',
  // Protocol 2: the user is working right now (no session held control), a point outside the
  // screen, a key name the VM does not know, text or a path too long for the target.
  'user_active', 'off_screen', 'unknown_key', 'too_long',
  // Gateway: unknown or evicted screenshot id, another agent holds the session, the browser is
  // not running, a view-only key.
  'stale_screenshot', 'busy_other_agent', 'browser_unavailable', 'view_only',
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
  /** The image's own size. */
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Protocol 2: the screen the image was scaled from; absent means the image is at screen size. */
  screenWidth: z.number().int().positive().optional(),
  screenHeight: z.number().int().positive().optional(),
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
  /** Protocol 2: screenshots honour `maxWidth`/`maxHeight`. */
  scaledShots: z.boolean().optional(),
  /** Protocol 2: a session (and its stored files) survives a tunnel reconnect within the grace period. */
  resume: z.boolean().optional(),
});
export type AutomationCapabilities = z.infer<typeof AutomationCapabilities>;

/** VM → gateway, for one coding-agent session. */
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

// --- api: access keys and status ---------------------------------------------------------------

export const AutomationClientName = z.string().trim().min(1).max(64);

/** `control` may act, attach and upload; `view` only takes screenshots and reads the status. */
export const AgentKeyCapability = z.enum(['control', 'view']);
export type AgentKeyCapability = z.infer<typeof AgentKeyCapability>;

/** How long a new key works; null never expires (it can still be revoked). */
export const AGENT_KEY_EXPIRY_DAYS = [7, 30, 90, 365] as const;

export const CreateAgentKeyBody = z.object({
  name: AutomationClientName,
  expiresInDays: z.union([z.literal(7), z.literal(30), z.literal(90), z.literal(365), z.null()]).default(90),
  capability: AgentKeyCapability.default('control'),
});
export type CreateAgentKeyBody = z.infer<typeof CreateAgentKeyBody>;

/** A new access key: `key` is shown once and never stored; only its hash is kept. */
export const AgentKey = z.object({
  clientId: z.string(),
  name: z.string(),
  /** `nvzk_` and 43 base62 characters. */
  key: z.string(),
  /** `nvzk_` and the key's first six characters, shown in the list to tell keys apart. */
  keyPrefix: z.string(),
  expiresAt: z.string().nullable(),
  capability: AgentKeyCapability,
  /** The remote MCP server URL a coding agent adds, with `Authorization: Bearer <key>`. */
  mcpUrl: z.string(),
});
export type AgentKey = z.infer<typeof AgentKey>;

export const AutomationClient = z.object({
  id: z.string(),
  name: z.string(),
  /**
   * `key`: an access key; `bridge`: a credential of the retired local bridge, accepted as a key;
   * `oauth`: a sign-in the owner approved in the browser (its name is the app's).
   */
  kind: z.enum(['key', 'bridge', 'oauth']),
  keyPrefix: z.string().nullable(),
  capability: AgentKeyCapability,
  createdAt: z.string(),
  /**
   * Null for keys that never expire; an expired key stays listed until it is revoked. A sign-in
   * always ends; an ended one is listed for a day more, since it can never work again.
   */
  expiresAt: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  /** The coding agent that last used the key (its MCP client name and version, or user agent). */
  lastClient: z.string().nullable(),
  /** A sign-in's verified domain (the host of its Client ID Metadata Document); null for keys and registered apps. */
  verifiedHost: z.string().nullable(),
});
export type AutomationClient = z.infer<typeof AutomationClient>;

/** Every key and sign-in of the user's browsers (the account page's Connected agents). */
export const AgentConnection = AutomationClient.extend({ instanceId: z.string(), instanceName: z.string() });
export type AgentConnection = z.infer<typeof AgentConnection>;

export const AutomationStatus = z.object({
  /** The owner's setting: whether coding agents may connect at all. */
  enabled: z.boolean(),
  mode: AgentControlMode,
  /** The remote MCP server URL for this browser (empty while the gateway is not configured). */
  mcpUrl: z.string(),
  clients: z.array(AutomationClient),
  /** The coding agent's session open now, if any. */
  session: z.object({ id: z.string(), clientId: z.string(), startedAt: z.string(), lastSeenAt: z.string() }).nullable(),
});
export type AutomationStatus = z.infer<typeof AutomationStatus>;

export const SetControlBody = z.object({ mode: AgentControlMode });

// --- api: OAuth sign-in (docs/agent-access.md, "OAuth sign-in") --------------------------------

/** How long a sign-in lasts, chosen on the approval page and counted from approval; it never moves. */
export const AGENT_GRANT_DAYS = [1, 7, 30, 90] as const;
export const DEFAULT_AGENT_GRANT_DAYS = 7;
export const AgentGrantDays = z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90)]);

/** OAuth scopes of a browser's MCP server: `browser:control` includes everything `browser:view` allows. */
export const AGENT_OAUTH_SCOPES = { control: 'browser:control', view: 'browser:view' } as const satisfies Record<AgentKeyCapability, string>;

/** The parameters of an authorization request (`/oauth/authorize?…`), exactly as the approval page received them. */
export const OAuthAuthorizeParams = z.record(z.string().max(64), z.string().max(4096));

export const OAuthCheckBody = z.object({ params: OAuthAuthorizeParams });
export type OAuthCheckBody = z.infer<typeof OAuthCheckBody>;

const OAuthBrowser = z.object({ id: z.string(), name: z.string(), agentAccess: z.boolean() });

/**
 * What the approval page shows, or why the request cannot be approved. `redirect` is where a
 * refusal may be sent back to the app: null when the app or its callback is unknown, which must
 * never be redirected to.
 */
export const OAuthAuthorizeCheck = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    /** What the app calls itself, and its verified domain when it has one. */
    client: z.object({ name: z.string(), verifiedHost: z.string().nullable() }),
    /** Where approving sends the user: an app on this computer, an installed app's scheme, or a website. */
    redirect: z.object({ kind: z.enum(['loopback', 'app', 'web']), label: z.string() }),
    /** The most the app asked for; the user may lower it. */
    capability: AgentKeyCapability,
    /** The browser the app named, or null when it named none and the user picks one of `browsers`. */
    browser: OAuthBrowser.nullable(),
    browsers: z.array(OAuthBrowser),
    grantDays: z.array(z.number().int()),
    defaultGrantDays: z.number().int(),
  }),
  z.object({ ok: z.literal(false), error: z.string(), description: z.string(), redirect: z.string().nullable() }),
]);
export type OAuthAuthorizeCheck = z.infer<typeof OAuthAuthorizeCheck>;

export const OAuthDecisionBody = z.object({
  params: OAuthAuthorizeParams,
  approve: z.boolean(),
  /** The browser, when the app named none. */
  instanceId: z.string().min(1).max(64).optional(),
  capability: AgentKeyCapability.optional(),
  grantDays: AgentGrantDays.default(DEFAULT_AGENT_GRANT_DAYS),
  /** Turns coding-agent access on for the browser as part of approving. */
  enableAccess: z.boolean().default(false),
});
export type OAuthDecisionBody = z.infer<typeof OAuthDecisionBody>;

/** Where the approval page sends the browser next: the app's callback, with a code or an error. */
export const OAuthDecision = z.object({ redirect: z.string() });
export type OAuthDecision = z.infer<typeof OAuthDecision>;
