import { z } from 'zod';

export const ViewerSession = z.object({
  id: z.string(),
  instanceId: z.string(),
  startedAt: z.string(),
});
export type ViewerSession = z.infer<typeof ViewerSession>;

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
