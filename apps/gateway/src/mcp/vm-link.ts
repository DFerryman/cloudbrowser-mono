import type { AutomationRequest, AutomationResponse } from '@cloudbrowser/contracts';

/**
 * Request and response pairing for one coding-agent session with the VM (docs/agent-access.md).
 * The VM answers each request with a `result` naming its id; a screenshot's bytes arrive first as
 * `blob` frames named by the screenshot's blob id. Blobs are kept per session by that id, never
 * attributed to whichever request happens to be waiting (the retired bridge did that, so two
 * concurrent calls could swap images). Buffered blob bytes are capped, and blobs nobody claims are
 * dropped after a minute. Pending requests live only in memory: a request in flight keeps the
 * Durable Object resident, and one that cannot finish fails with a reason the agent can act on.
 */

export type VmResult = Extract<AutomationResponse, { t: 'result' }>;
export type FileFrame = Extract<AutomationResponse, { t: 'file' }>;
export type VmOutcome = { result: VmResult; image?: string };

/** A request the VM could not be asked or did not answer; `reason` is a RejectReason. */
export class VmUnavailable extends Error {
  constructor(readonly reason: 'relay_unavailable' | 'timeout' | 'session_closed') {
    super(reason);
  }
}

/** Screenshot bytes a session may hold before they are claimed (a native 4K JPEG is ~1-2 MB). */
export const MAX_BUFFERED_BLOB_CHARS = 8 * 1024 * 1024;
/** A blob whose result never came (a timed-out or abandoned request) is dropped after this long. */
export const ORPHAN_BLOB_MS = 60_000;

/** Every part up to the last one arrived (a part dropped over the cap leaves a gap). */
function complete(blob: Blob) {
  if (blob.lastSeq === undefined || blob.parts.length !== blob.lastSeq + 1) return false;
  for (let i = 0; i <= blob.lastSeq; i++) if (blob.parts[i] === undefined) return false;
  return true;
}

type Pending = { resolve: (outcome: VmOutcome) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type Blob = { parts: string[]; chars: number; at: number; lastSeq?: number };

export class VmLink {
  private readonly pending = new Map<string, Pending>();
  private readonly blobs = new Map<string, Blob>();
  private blobChars = 0;
  private readonly transfers = new Map<string, (frame: FileFrame) => void>();

  /** `send` delivers one request to the VM, false when the tunnel is down. */
  constructor(readonly sessionId: string, private readonly send: (data: AutomationRequest) => boolean) {}

  get inFlight() {
    return this.pending.size;
  }

  /** Sends a request and resolves with its result and, for a screenshot, the image's base64. */
  request(data: Extract<AutomationRequest, { t: 'screenshot' | 'act' | 'status' | 'attach' }>, timeoutMs: number): Promise<VmOutcome> {
    return new Promise<VmOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(data.id);
        reject(new VmUnavailable('timeout'));
      }, timeoutMs);
      this.pending.set(data.id, { resolve, reject, timer });
      if (!this.send(data)) {
        clearTimeout(timer);
        this.pending.delete(data.id);
        reject(new VmUnavailable('relay_unavailable'));
      }
    });
  }

  /** Sends a request whose answer nobody waits for (cancel, file chunks). */
  post(data: AutomationRequest): boolean {
    return this.send(data);
  }

  /** Routes a transfer's `file` frames (progress, done, error) to `onFrame` until the returned stop is called. */
  watchTransfer(id: string, onFrame: (frame: FileFrame) => void): () => void {
    this.transfers.set(id, onFrame);
    return () => { if (this.transfers.get(id) === onFrame) this.transfers.delete(id); };
  }

  /** One frame of this session from the VM. Control and screen pushes are the caller's to read. */
  onFrame(data: AutomationResponse, now = Date.now()) {
    if (data.t === 'blob') {
      this.sweep(now);
      const blob = this.blobs.get(data.id) ?? { parts: [], chars: 0, at: now };
      if (blob.parts[data.seq] === undefined) {
        blob.parts[data.seq] = data.data;
        blob.chars += data.data.length;
        this.blobChars += data.data.length;
      }
      if (data.last) blob.lastSeq = data.seq;
      this.blobs.set(data.id, blob);
      // Over the cap, the oldest images go first: their requests are the likeliest to be abandoned.
      for (const [id, old] of this.blobs) {
        if (this.blobChars <= MAX_BUFFERED_BLOB_CHARS) break;
        this.dropBlob(id, old);
      }
      return;
    }
    if (data.t === 'result') {
      const waiting = this.pending.get(data.id);
      const blobId = data.screenshot?.blobId;
      const blob = blobId ? this.blobs.get(blobId) : undefined;
      if (blobId && blob) this.dropBlob(blobId, blob);
      if (!waiting) return; // a timed-out or cancelled request: nobody reads it
      clearTimeout(waiting.timer);
      this.pending.delete(data.id);
      waiting.resolve({ result: data, ...(blob && complete(blob) ? { image: blob.parts.join('') } : {}) });
      return;
    }
    if (data.t === 'file') this.transfers.get(data.id)?.(data);
  }

  /** Fails everything in flight at once (tunnel closed, session closed). */
  failAll(reason: VmUnavailable['reason']) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new VmUnavailable(reason));
    }
    this.pending.clear();
    for (const [, onFrame] of this.transfers) onFrame({ t: 'file', id: '', status: 'error', reason });
    this.transfers.clear();
    for (const [id, blob] of this.blobs) this.dropBlob(id, blob);
  }

  /** Drops blobs nobody claimed within ORPHAN_BLOB_MS. */
  sweep(now = Date.now()) {
    for (const [id, blob] of this.blobs) if (now - blob.at > ORPHAN_BLOB_MS) this.dropBlob(id, blob);
  }

  private dropBlob(id: string, blob: Blob) {
    this.blobs.delete(id);
    this.blobChars -= blob.chars;
  }
}
