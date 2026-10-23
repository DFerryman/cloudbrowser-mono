import { describe, expect, it } from 'vitest';
import { agentHandoff, agentServer, agentSetups, keyEnvCommands, keyEnvName, mcpConfig, serverName, SETUP_GUIDE_URL } from '../src/features/instances/agent-setup.js';

const url = 'https://connect.nevazu.com/mcp/abc123';
const server = agentServer({ url, browserName: 'Work' });

describe('coding-agent setup', () => {
  it('names the server and its key variable after the browser, safely', () => {
    expect(serverName('Browser 3')).toBe('nevazu-browser-3');
    expect(serverName('  Work / Ads — Tokyo  ')).toBe('nevazu-work-ads-tokyo');
    expect(serverName('浏览器')).toBe('nevazu-browser');
    expect(serverName('x'.repeat(80))).toHaveLength('nevazu-'.length + 40);
    expect(keyEnvName('Work / Ads')).toBe('NEVAZU_WORK_ADS_KEY');
    expect(keyEnvName('浏览器')).toBe('NEVAZU_BROWSER_KEY');
    expect(server).toEqual({ name: 'nevazu-work', url, env: 'NEVAZU_WORK_KEY' });
  });

  it('hands the agent a standard configuration that refers to the key by its variable', () => {
    expect(JSON.parse(mcpConfig(server))).toEqual({
      mcpServers: { 'nevazu-work': { type: 'http', url, headers: { Authorization: 'Bearer ${NEVAZU_WORK_KEY}' } } },
    });
    const handoff = agentHandoff(server, 'Work\n"x"');
    expect(handoff).toContain(mcpConfig(server));
    expect(handoff).toContain(SETUP_GUIDE_URL);
    expect(handoff).toContain('NEVAZU_WORK_KEY');
    expect(handoff).not.toContain('nvzk_');
    expect(handoff.split('\n')[0]).toContain('"Work "x""');
  });

  it('never puts a key in any client setup', () => {
    for (const setup of agentSetups(server)) {
      expect(setup.code).toContain(url);
      expect(setup.code).not.toMatch(/nvzk_|YOUR_ACCESS_KEY/);
      // VS Code asks for the key and keeps it in its secret storage; every other client reads the variable.
      if (setup.client !== 'vscode') expect(setup.code).toContain('NEVAZU_WORK_KEY');
    }
  });

  it('produces valid configuration in each client’s own format', () => {
    const code = (client: string) => agentSetups(server).find((s) => s.client === client)!.code;
    expect(code('claude-code')).toBe(`claude mcp add-json --scope user nevazu-work '{"type":"http","url":"${url}","headers":{"Authorization":"Bearer \${NEVAZU_WORK_KEY}"}}'`);
    expect(JSON.parse(code('claude-code').slice(code('claude-code').indexOf("'") + 1, -1)).url).toBe(url);
    expect(JSON.parse(code('cursor'))).toEqual({ mcpServers: { 'nevazu-work': { url, headers: { Authorization: 'Bearer ${env:NEVAZU_WORK_KEY}' } } } });
    expect(JSON.parse(code('windsurf')).mcpServers['nevazu-work'].headers.Authorization).toBe('Bearer ${env:NEVAZU_WORK_KEY}');
    expect(JSON.parse(code('gemini')).mcpServers['nevazu-work']).toEqual({ httpUrl: url, headers: { Authorization: 'Bearer ${NEVAZU_WORK_KEY}' } });
    expect(JSON.parse(code('opencode')).mcp['nevazu-work']).toMatchObject({ type: 'remote', url, oauth: false, headers: { Authorization: 'Bearer {env:NEVAZU_WORK_KEY}' } });
    expect(JSON.parse(code('vscode')).servers['nevazu-work'].headers.Authorization).toBe('Bearer ${input:nevazu-work-key}');
    expect(code('codex')).toContain('bearer_token_env_var = "NEVAZU_WORK_KEY"');
    expect(code('other')).toContain('Bearer $NEVAZU_WORK_KEY"');
  });

  it('saves a new key in the variable on each system', () => {
    const { unix, windows } = keyEnvCommands('NEVAZU_WORK_KEY', 'nvzk_abc');
    expect(unix).toContain(`echo 'export NEVAZU_WORK_KEY="nvzk_abc"' >> ~/.zshrc`);
    expect(windows).toContain('setx NEVAZU_WORK_KEY "nvzk_abc"');
  });
});
