import { z } from 'zod';

export const ViewerSession = z.object({
  id: z.string(),
  instanceId: z.string(),
  startedAt: z.string(),
});
export type ViewerSession = z.infer<typeof ViewerSession>;

const MediaCounter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const CandidateType = z.enum(['host', 'srflx', 'prflx', 'relay']);

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
  issue: z.enum(['offline', 'background', 'network', 'service', 'desktop']).optional(),
  media: ConnectionMediaSnapshot.optional(),
}).strict().refine((value) => value.media === undefined || value.stage === 'failed' || value.stage === 'first_frame', {
  message: 'Media snapshots are only accepted at failure or first frame', path: ['media'],
});
export type ConnectionDiagnostic = z.infer<typeof ConnectionDiagnostic>;

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
