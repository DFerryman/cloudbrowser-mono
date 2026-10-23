import { describe, expect, it } from 'vitest';
import { agentSetups, KEY_PLACEHOLDER, serverName } from '../src/features/instances/agent-setup.js';

const url = 'https://connect.nevazu.com/mcp/abc123';

describe('coding-agent setup snippets', () => {
  it('names the server after the browser, safely', () => {
    expect(serverName('Browser 3')).toBe('nevazu-browser-3');
    expect(serverName('  Work / Ads — Tokyo  ')).toBe('nevazu-work-ads-tokyo');
    expect(serverName('浏览器')).toBe('nevazu-browser');
    expect(serverName('x'.repeat(80))).toHaveLength('nevazu-'.length + 40);
  });

  it('embeds the URL and a freshly created key in every client', () => {
    const key = 'nvzk_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
    for (const setup of agentSetups({ url, key, browserName: 'Work' })) {
      expect(setup.code).toContain(url);
      // VS Code prompts for the key and keeps it in its secret storage instead.
      if (setup.client === 'vscode') expect(setup.code).toContain('${input:nevazu-key}');
      else expect(setup.code).toContain(key);
    }
  });

  it('uses a placeholder when the key is not known', () => {
    const setups = agentSetups({ url, browserName: 'Work' });
    expect(setups.find((s) => s.client === 'claude-code')!.code)
      .toBe(`claude mcp add --transport http --scope user nevazu-work ${url} --header "Authorization: Bearer ${KEY_PLACEHOLDER}"`);
  });

  it('produces valid JSON configuration files', () => {
    for (const setup of agentSetups({ url, browserName: 'Work' }).filter((s) => s.where.endsWith('.json'))) {
      expect(() => JSON.parse(setup.code)).not.toThrow();
    }
    const cursor = JSON.parse(agentSetups({ url, browserName: 'Work' }).find((s) => s.client === 'cursor')!.code);
    expect(cursor).toEqual({ mcpServers: { 'nevazu-work': { url, headers: { Authorization: `Bearer ${KEY_PLACEHOLDER}` } } } });
  });

  it('keeps the Codex key in an environment variable, not the config file', () => {
    const codex = agentSetups({ url, key: 'nvzk_secret', browserName: 'Work' }).find((s) => s.client === 'codex')!.code;
    const toml = codex.slice(codex.indexOf('[mcp_servers'));
    expect(toml).not.toContain('nvzk_secret');
    expect(toml).toContain('bearer_token_env_var = "NEVAZU_KEY"');
    expect(codex).toContain('export NEVAZU_KEY="nvzk_secret"');
  });
});
