import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstanceGateway } from '../../gateway/src/instance-gateway.js';

type Attachment = { role: 'agent'; generation: number } | { role: 'viewer'; sessionId: string };

class Socket {
  readonly send = vi.fn();
  constructor(readonly attachment: Attachment, readonly readyState = 1) {}
  deserializeAttachment() { return this.attachment; }
}

function gateway(sockets: Socket[]) {
  vi.stubGlobal('WebSocket', { OPEN: 1 });
  vi.stubGlobal('WebSocketRequestResponsePair', class {});
  const ctx = {
    setWebSocketAutoResponse: vi.fn(),
    getWebSockets: (tag: string) => sockets.filter((s) =>
      s.attachment.role === tag || (s.attachment.role === 'viewer' && tag === `session:${s.attachment.sessionId}`),
    ),
  };
  return new InstanceGateway(ctx as unknown as DurableObjectState, {} as never);
}

afterEach(() => vi.unstubAllGlobals());

describe('gateway viewer reconnect cleanup', () => {
  it('keeps the new relay when a replaced socket closes after the same session reconnects', async () => {
    const agent = new Socket({ role: 'agent', generation: 1 });
    const old = new Socket({ role: 'viewer', sessionId: 'same-session' }, 3);
    const replacement = new Socket({ role: 'viewer', sessionId: 'same-session' });
    const instance = gateway([agent, old, replacement]);

    await instance.webSocketClose(old as unknown as WebSocket);

    expect(agent.send).not.toHaveBeenCalled();
  });

  it('closes only the old session when another session takes over', async () => {
    const agent = new Socket({ role: 'agent', generation: 1 });
    const old = new Socket({ role: 'viewer', sessionId: 'old-session' }, 3);
    const replacement = new Socket({ role: 'viewer', sessionId: 'new-session' });
    const instance = gateway([agent, old, replacement]);

    await instance.webSocketClose(old as unknown as WebSocket);

    expect(agent.send.mock.calls.map(([frame]) => JSON.parse(frame))).toEqual([
      { t: 'viewer_close', sessionId: 'old-session' },
    ]);
  });

  it.each([{ states: [] }, { states: [2] }, { states: [3] }])('cleans up the last live viewer with replacement states $states', async ({ states }) => {
    const agent = new Socket({ role: 'agent', generation: 1 });
    const closing = new Socket({ role: 'viewer', sessionId: 'last-session' }, 3);
    const replacements = states.map((state) => new Socket({ role: 'viewer', sessionId: 'last-session' }, state));
    const instance = gateway([agent, closing, ...replacements]);

    await instance.webSocketClose(closing as unknown as WebSocket);

    expect(agent.send.mock.calls.map(([frame]) => JSON.parse(frame))).toEqual([
      { t: 'viewer_close', sessionId: 'last-session' },
    ]);
  });

  it('also preserves the replacement when the old socket reports an error', async () => {
    const agent = new Socket({ role: 'agent', generation: 1 });
    const old = new Socket({ role: 'viewer', sessionId: 'same-session' }, 3);
    const replacement = new Socket({ role: 'viewer', sessionId: 'same-session' });
    const instance = gateway([agent, replacement]);

    await instance.webSocketError(old as unknown as WebSocket);

    expect(agent.send).not.toHaveBeenCalled();
  });
});
