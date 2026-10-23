import { AUTOMATION_LIMITS, type ActionStep, type ScreenshotMeta } from '@cloudbrowser/contracts';

/**
 * A coding agent's session as the browser's Durable Object keeps it (docs/agent-access.md): the
 * "virtual bridge". It lives in the object's storage under `mcp`, so it survives eviction and
 * deploys; only requests in flight live in memory. One session per browser at a time.
 */

/** A screenshot the agent may still refer to, and how its image maps onto the screen. */
export type Shot = {
  id: string;
  screenVersion: number;
  controlEpoch: number;
  imageWidth: number;
  imageHeight: number;
  screenWidth: number;
  screenHeight: number;
};

/** A one-time upload URL: only the secret's hash is kept. */
export type UploadSlot = {
  secretHash: string;
  name: string;
  size: number;
  mime: string;
  expiresAt: number;
  state: 'pending' | 'uploading' | 'done' | 'failed';
};

export type McpRecord = {
  sessionId: string;
  clientId: string;
  userId: string;
  generation: number;
  startedAt: number;
  lastUsedAt: number;
  /** The MCP client (name/version from `initialize`, else its user agent) and the key's name. */
  clientName: string;
  keyName: string;
  /** The last SHOT_RING screenshots, oldest first. */
  shots: Shot[];
  latestShotId: string | null;
  /** Files stored in the VM for this session: handle → name and size. */
  handles: Record<string, { name: string; size: number }>;
  uploads: Record<string, UploadSlot>;
  /** When `automation_open` last went to the VM: an older VM needs a moment until its desktop is ready. */
  openedAt: number;
  /** The VM's automation protocol, once a status result told it. */
  vmProtocol?: number;
};

/** What the session's last close was, so the client's next call can say its files are gone. */
export type McpEnded = { clientId: string; reason: string; at: number; files: number };

export const SHOT_RING = 16;
/** A different agent's call is refused while the session was used this recently; after that it takes over. */
export const BUSY_OTHER_AGENT_MS = 60_000;

export function rememberShot(rec: McpRecord, meta: ScreenshotMeta) {
  const shot: Shot = {
    id: meta.id, screenVersion: meta.screenVersion, controlEpoch: meta.controlEpoch,
    imageWidth: meta.width, imageHeight: meta.height,
    // A protocol 1 VM sends the screen as it is: the image is the screen.
    screenWidth: meta.screenWidth ?? meta.width, screenHeight: meta.screenHeight ?? meta.height,
  };
  rec.shots = [...rec.shots.filter((s) => s.id !== shot.id), shot].slice(-SHOT_RING);
  rec.latestShotId = shot.id;
  return shot;
}

/** The screenshot coordinates refer to: the one named, or the latest. Undefined when evicted or unknown. */
export function basisShot(rec: McpRecord, screenshotId: string | undefined): Shot | undefined {
  const id = screenshotId ?? rec.latestShotId;
  return id ? rec.shots.find((s) => s.id === id) : undefined;
}

/** One image pixel to the screen pixel under it, kept on the screen. */
export function mapPoint(shot: Shot, x: number, y: number) {
  return {
    x: Math.max(0, Math.min(shot.screenWidth - 1, Math.round((x * shot.screenWidth) / shot.imageWidth))),
    y: Math.max(0, Math.min(shot.screenHeight - 1, Math.round((y * shot.screenHeight) / shot.imageHeight))),
  };
}

/** Every coordinate of `steps` (points and drag paths) from image pixels to screen pixels. */
export function mapSteps(steps: readonly ActionStep[], shot: Shot): ActionStep[] {
  return steps.map((step) => {
    if (step.type === 'drag') return { ...step, path: step.path.map((p) => mapPoint(shot, p.x, p.y)) };
    if ('x' in step && step.x !== undefined && step.y !== undefined) return { ...step, ...mapPoint(shot, step.x, step.y) };
    return step;
  });
}

/** The screenshot bounds sent to the VM: `fit` scales down (protocol 2), `native` asks for none. */
export const shotBounds = (size: 'fit' | 'native' | undefined) =>
  size === 'native' ? {} : { maxWidth: AUTOMATION_LIMITS.fitWidth, maxHeight: AUTOMATION_LIMITS.fitHeight };

// --- one-time upload URLs ----------------------------------------------------------------------

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A slot id and its secret (32 random bytes); the URL token is `<instanceId>.<slotId>.<secret>`. */
export function newSlotSecret() {
  return { slotId: b64url(crypto.getRandomValues(new Uint8Array(12))), secret: b64url(crypto.getRandomValues(new Uint8Array(32))) };
}

export const UPLOAD_TOKEN = /^([A-Za-z0-9]{1,64})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/;

export function parseUploadToken(token: string): { instanceId: string; slotId: string; secret: string } | null {
  const m = token.match(UPLOAD_TOKEN);
  return m ? { instanceId: m[1]!, slotId: m[2]!, secret: m[3]! } : null;
}

/** Compares two hex digests without an early exit, so timing does not reveal a prefix. */
export function sameDigest(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** A short random id for VM requests and transfers. */
export const requestId = () => b64url(crypto.getRandomValues(new Uint8Array(12)));
