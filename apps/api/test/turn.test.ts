import { describe, expect, it } from 'vitest';
import { inTcpRelayTest, tcpRelayServers } from '../src/turn.js';

describe('relay transport test', () => {
  it('puts half of the sessions of viewers in China in the TCP half, by the last character of the session id', () => {
    const hex = 'a'.repeat(63);
    expect([...'0123456789abcdef'].filter((d) => inTcpRelayTest(hex + d, 'CN')).join('')).toBe('13579bdf');
    expect(inTcpRelayTest(`01JB${'0'.repeat(21)}Z`, 'CN')).toBe(true);
    expect(inTcpRelayTest(`01JB${'0'.repeat(21)}Y`, 'CN')).toBe(false);
    expect(inTcpRelayTest(`${hex}1`, 'GB')).toBe(false);
    expect(inTcpRelayTest(`${hex}1`, undefined)).toBe(false);
  });

  it('keeps only the TCP and TLS relay addresses, or every address when there are none', () => {
    const servers = [
      { urls: ['stun:stun.cloudflare.com:3478'] },
      {
        urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:3478?transport=tcp', 'turn:turn.cloudflare.com:80?transport=tcp',
          'turns:turn.cloudflare.com:5349?transport=tcp', 'turns:turn.cloudflare.com:443?transport=tcp'],
        username: 'u', credential: 'c',
      },
    ];
    expect(tcpRelayServers(servers)).toEqual([{
      urls: ['turn:turn.cloudflare.com:3478?transport=tcp', 'turn:turn.cloudflare.com:80?transport=tcp',
        'turns:turn.cloudflare.com:5349?transport=tcp', 'turns:turn.cloudflare.com:443?transport=tcp'],
      username: 'u', credential: 'c',
    }]);
    const udp = [{ urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:3478?transport=tcpx'], username: 'u', credential: 'c' }];
    expect(tcpRelayServers(udp)).toBe(udp);
  });
});
