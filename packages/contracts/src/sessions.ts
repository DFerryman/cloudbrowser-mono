import { z } from 'zod';

export const ViewerSession = z.object({
  id: z.string(),
  instanceId: z.string(),
  startedAt: z.string(),
});
export type ViewerSession = z.infer<typeof ViewerSession>;

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
  ]),
  elapsedMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  code: z.enum([
    'token_timeout', 'token_failed', 'transport_error', 'transport_closed', 'agent_offline',
    'relay_failed', 'connection_timeout', 'negotiation_failed', 'retry_exhausted', 'canceled',
    'login_timeout', 'login_rejected', 'login_unavailable', 'websocket_timeout',
    'websocket_unavailable', 'desktop_timeout', 'relay_unavailable',
  ]).optional(),
}).strict();
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
