import type { ConnectionHandshake, ConnectionMediaSnapshot } from '@cloudbrowser/contracts';
import { readHandshake } from './stats.js';

/** How often a handshake is read while its peer has not connected; startStats takes over once it has. */
export const HANDSHAKE_PROBE_MS = 1000;
const MAX_TURN_ERRORS = 8;
const MAX_MS = 600_000;

type PeerStates = Pick<RTCPeerConnection, 'iceConnectionState' | 'connectionState'>;

/**
 * The first step of a handshake that did not happen, for a peer that never showed a picture
 * (ConnectionHandshake.stalledAt). `media` carries the latest video counters; without a recent
 * reading of them, a connected peer's stall is left unknown rather than guessed.
 */
export function stalledAt(
  reached: { candidate: boolean; ice: boolean; peer: boolean },
  pc: Partial<PeerStates>,
  media: ConnectionMediaSnapshot,
): ConnectionHandshake['stalledAt'] {
  const peer = reached.peer || pc.connectionState === 'connected';
  const ice = peer || reached.ice || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed';
  if (!ice) return reached.candidate ? 'ice' : 'candidates';
  if (!peer) return 'dtls';
  if (media.inboundVideo === undefined) return undefined;
  if (!media.inboundVideo || !media.video?.bytesReceived) return 'media';
  if (!media.video.framesDecoded) return 'decode';
  return 'render';
}

/**
 * Watches one peer's handshake from neko's offer on: when its first local candidate came, when ICE
 * and the peer (DTLS) connected, the STUN/TURN error codes it met and, every second until the peer
 * connects, getStats' counts. A failure snapshot then says how far the handshake got, and the first
 * frame's how long each step took. Readings also stand in for startStats' media sample, which only
 * starts once the peer has connected (connected()).
 */
export class HandshakeProbe {
  private readonly startedAt = Date.now();
  private candidateAt: number | null = null;
  private iceAt: number | null = null;
  private peerAt: number | null = null;
  private readonly turnErrors: number[] = [];
  private counts: ConnectionHandshake = {};
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending = false;
  private stopped = false;

  constructor(
    readonly pc: RTCPeerConnection,
    private readonly onMedia: (media: ConnectionMediaSnapshot, at: number) => void,
    intervalMs = HANDSHAKE_PROBE_MS,
  ) {
    // Listeners, not the on* handlers RemoteBrowser sets: those stay its own.
    if (typeof pc.addEventListener === 'function') {
      pc.addEventListener('icecandidate', this.candidate);
      pc.addEventListener('icecandidateerror', this.candidateError);
      pc.addEventListener('iceconnectionstatechange', this.iceState);
    }
    if (typeof pc.getStats === 'function') this.timer = setInterval(() => void this.read(), intervalMs);
  }

  /** The peer connected (DTLS is up): startStats reads it from here on. */
  connected() {
    this.peerAt ??= Date.now();
    this.stopReading();
  }

  /** The handshake so far; with `failed`, also where it stalled. */
  snapshot(failed?: { media: ConnectionMediaSnapshot }): ConnectionHandshake {
    const handshake: ConnectionHandshake = { ...this.counts };
    const candidateMs = this.since(this.candidateAt);
    const iceMs = this.since(this.iceAt);
    const dtlsMs = this.since(this.peerAt);
    if (candidateMs !== undefined) handshake.candidateMs = candidateMs;
    if (iceMs !== undefined) handshake.iceMs = iceMs;
    if (dtlsMs !== undefined) handshake.dtlsMs = dtlsMs;
    if (this.turnErrors.length) handshake.turnErrors = [...this.turnErrors];
    if (failed) {
      const candidates = this.counts.candidates;
      const gathered = this.candidateAt !== null || (!!candidates && candidates.relayUdp + candidates.relayTcp + candidates.relayTls + candidates.other > 0);
      const stall = stalledAt({ candidate: gathered, ice: this.iceAt !== null, peer: this.peerAt !== null }, this.pc, failed.media);
      if (stall) handshake.stalledAt = stall;
    }
    return handshake;
  }

  stop() {
    this.stopped = true;
    this.stopReading();
    if (typeof this.pc.removeEventListener !== 'function') return;
    this.pc.removeEventListener('icecandidate', this.candidate);
    this.pc.removeEventListener('icecandidateerror', this.candidateError);
    this.pc.removeEventListener('iceconnectionstatechange', this.iceState);
  }

  private since(at: number | null) {
    return at === null ? undefined : Math.min(MAX_MS, Math.max(0, Math.round(at - this.startedAt)));
  }

  private stopReading() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async read() {
    if (this.pending || this.stopped) return;
    this.pending = true;
    const at = Date.now();
    try {
      const reading = await readHandshake(this.pc);
      if (this.stopped) return;
      this.counts = reading.handshake;
      this.onMedia(reading.media, at);
    } catch {
      // A closing peer; its last reading stands.
    } finally {
      this.pending = false;
    }
  }

  private readonly candidate = (e: RTCPeerConnectionIceEvent) => {
    if (e.candidate && this.candidateAt === null) this.candidateAt = Date.now();
  };

  /** Codes only: the event's URL and text name the TURN server and can carry an address. */
  private readonly candidateError = (e: Event) => {
    const code = (e as RTCPeerConnectionIceErrorEvent).errorCode;
    if (Number.isInteger(code) && code >= 0 && code <= 999 && !this.turnErrors.includes(code) && this.turnErrors.length < MAX_TURN_ERRORS) {
      this.turnErrors.push(code);
    }
  };

  private readonly iceState = () => {
    if (this.iceAt === null && (this.pc.iceConnectionState === 'connected' || this.pc.iceConnectionState === 'completed')) this.iceAt = Date.now();
  };
}
