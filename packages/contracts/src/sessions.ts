import { z } from 'zod';
import { VIDEO_QUALITIES } from './instances.js';

export const ViewerSession = z.object({
  id: z.string(),
  instanceId: z.string(),
  startedAt: z.string(),
});
export type ViewerSession = z.infer<typeof ViewerSession>;

const MediaCounter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const CandidateType = z.enum(['host', 'srflx', 'prflx', 'relay']);

const Milliseconds = z.number().int().min(0).max(600_000);

/**
 * How far a WebRTC handshake got, from neko's offer on, for a picture that never came (and, at the
 * first frame, how long each step took). Counts, states and STUN/TURN error codes only: never
 * candidate addresses, URLs or error texts (docs/connection-diagnostics.md, "Handshake").
 */
export const ConnectionHandshake = z.object({
  /**
   * At failure, the first step that did not happen: `candidates` no local (relay) candidate, so
   * the TURN relay was not reached or refused; `ice` no candidate pair worked; `dtls` the pair
   * worked but the encrypted session never opened; `media` it opened but no video arrived;
   * `decode` video arrived but no frame decoded; `render` frames decoded but none was shown.
   */
  stalledAt: z.enum(['candidates', 'ice', 'dtls', 'media', 'decode', 'render']).optional(),
  /** From neko's offer: the first local candidate, ICE connected, the peer (DTLS) connected. */
  candidateMs: Milliseconds.optional(),
  iceMs: Milliseconds.optional(),
  dtlsMs: Milliseconds.optional(),
  /** Distinct icecandidateerror codes, in order (701: a STUN/TURN server did not answer; 4xx/5xx: it refused). */
  turnErrors: z.array(z.number().int().min(0).max(999)).max(8).optional(),
  /** Local candidates gathered: relays by the protocol to the TURN server, and any others. */
  candidates: z.object({
    relayUdp: MediaCounter, relayTcp: MediaCounter, relayTls: MediaCounter, other: MediaCounter,
  }).strict().optional(),
  /** Candidate pairs by state. */
  pairs: z.object({
    succeeded: MediaCounter, inProgress: MediaCounter, waiting: MediaCounter, failed: MediaCounter,
  }).strict().optional(),
  /** Connectivity checks sent on every pair, and the answers that came back. */
  checksSent: MediaCounter.optional(),
  checksAnswered: MediaCounter.optional(),
  dtlsState: z.enum(['new', 'connecting', 'connected', 'closed', 'failed']).optional(),
  /** Bytes the transport received (DTLS and media): whether anything came back on the pair at all. */
  transportBytesReceived: MediaCounter.optional(),
}).strict();
export type ConnectionHandshake = z.infer<typeof ConnectionHandshake>;

/** Fixed, bounded media evidence. No candidate addresses, credentials, SDP or error messages. */
export const ConnectionMediaSnapshot = z.object({
  connectionState: z.enum(['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed']).optional(),
  iceConnectionState: z.enum(['new', 'checking', 'connected', 'completed', 'disconnected', 'failed', 'closed']).optional(),
  iceGatheringState: z.enum(['new', 'gathering', 'complete']).optional(),
  sampleAgeMs: z.number().int().min(0).max(5_000).optional(),
  inboundVideo: z.boolean().optional(),
  rttMs: MediaCounter.optional(),
  localCandidateType: CandidateType.optional(),
  remoteCandidateType: CandidateType.optional(),
  protocol: z.enum(['udp', 'tcp']).optional(),
  relayProtocol: z.enum(['udp', 'tcp', 'tls']).optional(),
  video: z.object({
    bytesReceived: MediaCounter.optional(),
    packetsReceived: MediaCounter.optional(),
    // RTCStats can report negative cumulative loss after duplicate/late arrivals.
    packetsLost: z.number().int().min(-2_147_483_648).max(Number.MAX_SAFE_INTEGER).optional(),
    framesReceived: MediaCounter.optional(),
    framesDecoded: MediaCounter.optional(),
    keyFramesDecoded: MediaCounter.optional(),
    nackCount: MediaCounter.optional(),
    pliCount: MediaCounter.optional(),
    jitterMs: MediaCounter.optional(),
  }).strict().optional(),
  playback: z.object({
    paused: z.boolean(),
    readyState: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    width: z.number().int().min(0).max(32_768),
    height: z.number().int().min(0).max(32_768),
    visibility: z.enum(['visible', 'hidden', 'unknown']),
    playState: z.enum(['unknown', 'resolved', 'not_allowed', 'unsupported', 'aborted', 'failed']),
    frameCallback: z.boolean(),
  }).strict().optional(),
  handshake: ConnectionHandshake.optional(),
}).strict();
export type ConnectionMediaSnapshot = z.infer<typeof ConnectionMediaSnapshot>;

/** Client observations complement gateway/agent logs when the stream never opens. */
export const ConnectionDiagnostic = z.object({
  attemptId: z.string().uuid(),
  relayId: z.string().uuid().optional(),
  /** Renegotiated peers can share one gateway WebSocket attempt. */
  peerSequence: z.number().int().nonnegative().max(2_147_483_647).optional(),
  stage: z.enum([
    'token_start', 'token_ok', 'transport_start', 'transport_open', 'gateway_accepted',
    'agent_received', 'login_start', 'login_ok', 'websocket_start', 'websocket_open',
    'desktop_ready', 'signal_received', 'peer_connected', 'first_frame', 'failed', 'closed',
    // The media path dropped while live: an ICE restart on the same socket, and its recovery.
    'media_restart', 'media_recovered',
  ]),
  elapsedMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  code: z.enum([
    'token_timeout', 'token_failed', 'transport_error', 'transport_closed', 'agent_offline',
    'relay_failed', 'connection_timeout', 'negotiation_failed', 'retry_exhausted', 'canceled',
    'login_timeout', 'login_rejected', 'login_unavailable', 'websocket_timeout',
    'websocket_unavailable', 'desktop_timeout', 'relay_unavailable',
    // The socket stopped answering pings (a network that dropped it without closing it), and a
    // media path an ICE restart could not bring back.
    'transport_stale', 'media_failed',
  ]).optional(),
  /** The WebSocket close code a closed transport reported (1006: dropped without a close frame). */
  closeCode: z.number().int().min(1000).max(4999).optional(),
  /** What the page told the user about this failure. */
  issue: z.enum(['offline', 'background', 'network', 'gateway', 'service', 'desktop']).optional(),
  media: ConnectionMediaSnapshot.optional(),
}).strict().refine((value) => value.media === undefined || value.stage === 'failed' || value.stage === 'first_frame', {
  message: 'Media snapshots are only accepted at failure or first frame', path: ['media'],
});
export type ConnectionDiagnostic = z.infer<typeof ConnectionDiagnostic>;

/**
 * About a minute of a live view's quality, for baselines by browser region and viewer country
 * (docs/connection-diagnostics.md, "Live quality"). Medians and totals over the interval, read
 * from getStats and the gateway's pongs: never addresses, SDP or what is on screen.
 */
export const LiveQualityReport = z.object({
  attemptId: z.string().uuid(),
  /** The interval covered: a minute, or less when the view ended, was hidden or the page froze sooner. */
  durationMs: z.number().int().min(1_000).max(600_000),
  /** Stats readings (one every 2 s) in the interval. */
  readings: z.number().int().min(1).max(600),
  /** The picture's round trip on its selected candidate pair, through the TURN relay; median. */
  rttMs: Milliseconds.nullable(),
  /** The input socket's round trip to the gateway (ping to pong); median, null without a ping in the interval. */
  gatewayRttMs: Milliseconds.nullable(),
  fps: z.number().min(0).max(240).nullable(),
  kbps: z.number().int().min(0).max(1_000_000).nullable(),
  /** Share of video packets lost in the interval, 0–1. */
  loss: z.number().min(0).max(1).nullable(),
  freezes: z.number().int().min(0).max(100_000),
  /** Time the picture spent frozen in the interval; null where the browser does not report it. */
  freezeMs: Milliseconds.nullable(),
  /** Average time a frame waited in the jitter buffer, and took to decode. */
  jitterBufferMs: z.number().min(0).max(60_000).nullable(),
  decodeMs: z.number().min(0).max(60_000).nullable(),
  framesDropped: z.number().int().min(0).max(1_000_000).nullable(),
  /** The picture level neko streamed at the end of the interval. */
  quality: z.enum(VIDEO_QUALITIES).nullable(),
  width: z.number().int().min(0).max(32_768).nullable(),
  height: z.number().int().min(0).max(32_768).nullable(),
  localCandidateType: CandidateType.optional(),
  relayProtocol: z.enum(['udp', 'tcp', 'tls']).optional(),
  /**
   * Repairs in the interval: NACKs sent (packets asked for again), retransmissions received, and
   * picture loss indications (keyframes asked for). Loss that retransmission repaired never shows
   * in `loss`, yet costs a round trip per repair. Optional: older viewers do not send them.
   */
  nacks: z.number().int().min(0).max(1_000_000).nullable().optional(),
  retransmits: z.number().int().min(0).max(1_000_000).nullable().optional(),
  plis: z.number().int().min(0).max(100_000).nullable().optional(),
  keyframes: z.number().int().min(0).max(100_000).nullable().optional(),
  /** Times the viewer switched picture level in the interval. */
  levelChanges: z.number().int().min(0).max(10_000).optional(),
  /**
   * The average delay the browser aimed to hold each frame for (its smoothing, and keeping the
   * picture in step with the sound). `jitterBufferMs` above it is time frames waited for packets
   * still missing, mostly resends. Optional: older viewers do not send it.
   */
  jitterBufferTargetMs: z.number().min(0).max(60_000).nullable().optional(),
  /**
   * The least of that target the path's jitter called for, before keeping the picture in step with
   * the sound (and any delay the viewer asked for). `jitterBufferTargetMs` above it is the browser
   * holding the picture back to match the sound. Optional: older viewers do not send it.
   */
  jitterBufferMinimumMs: z.number().min(0).max(60_000).nullable().optional(),
}).strict();
export type LiveQualityReport = z.infer<typeof LiveQualityReport>;

/**
 * `simulated` is returned while the instance runs on the `fake` executor: there is no gateway or
 * TURN relay to connect to, and the session view shows a placeholder instead of a stream.
 */
export const ConnectInfo = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('simulated') }),
  z.object({
    mode: z.literal('webrtc'),
    gatewayUrl: z.string(),
    token: z.string(),
    iceServers: z.array(
      z.object({ urls: z.array(z.string()), username: z.string().optional(), credential: z.string().optional() }),
    ),
  }),
]);
export type ConnectInfo = z.infer<typeof ConnectInfo>;
