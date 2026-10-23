/**
 * Copy-paste setup for connecting a coding agent to a browser's hosted MCP endpoint
 * (docs/agent-access.md). Nothing is installed: every client below adds a remote MCP server by
 * URL and sends the access key as a bearer header. A key is known only right after it is created;
 * otherwise the snippets carry a placeholder the user replaces.
 */

export const KEY_PLACEHOLDER = 'YOUR_ACCESS_KEY';

export type AgentClient = 'claude-code' | 'cursor' | 'codex' | 'vscode' | 'windsurf' | 'gemini' | 'other';

export interface AgentSetup {
  client: AgentClient;
  label: string;
  /** Where the snippet goes: a terminal, or a configuration file's usual path. */
  where: string;
  code: string;
}

/** The server's name in the agent's configuration: one per browser, so several can coexist. */
export function serverName(browserName: string): string {
  const slug = browserName.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return `nevazu-${slug || 'browser'}`;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

export function agentSetups({ url, key, browserName }: { url: string; key?: string | null; browserName: string }): AgentSetup[] {
  const name = serverName(browserName);
  const secret = key || KEY_PLACEHOLDER;
  const bearer = `Bearer ${secret}`;
  return [
    {
      client: 'claude-code',
      label: 'Claude Code',
      where: 'Terminal',
      code: `claude mcp add --transport http --scope user ${name} ${url} --header "Authorization: ${bearer}"`,
    },
    {
      client: 'cursor',
      label: 'Cursor',
      where: '~/.cursor/mcp.json',
      code: json({ mcpServers: { [name]: { url, headers: { Authorization: bearer } } } }),
    },
    {
      client: 'codex',
      label: 'Codex CLI',
      where: '~/.codex/config.toml',
      // Codex reads a bearer token from an environment variable, so the key stays out of the file.
      code: [
        '# In your shell profile (~/.zshrc, ~/.bashrc):',
        `export NEVAZU_KEY="${secret}"`,
        '',
        '# In ~/.codex/config.toml:',
        `[mcp_servers.${name}]`,
        `url = "${url}"`,
        'bearer_token_env_var = "NEVAZU_KEY"',
        'tool_timeout_sec = 90',
      ].join('\n'),
    },
    {
      client: 'vscode',
      label: 'VS Code',
      where: '.vscode/mcp.json',
      // VS Code asks for the key once and keeps it in its secret storage, never in the file.
      code: json({
        inputs: [{ type: 'promptString', id: 'nevazu-key', description: 'Nevazu access key', password: true }],
        servers: { [name]: { type: 'http', url, headers: { Authorization: 'Bearer ${input:nevazu-key}' } } },
      }),
    },
    {
      client: 'windsurf',
      label: 'Windsurf',
      where: '~/.codeium/windsurf/mcp_config.json',
      code: json({ mcpServers: { [name]: { serverUrl: url, headers: { Authorization: bearer } } } }),
    },
    {
      client: 'gemini',
      label: 'Gemini CLI',
      where: '~/.gemini/settings.json',
      code: json({ mcpServers: { [name]: { httpUrl: url, headers: { Authorization: bearer } } } }),
    },
    {
      client: 'other',
      label: 'Other',
      where: 'Any MCP client (Streamable HTTP)',
      code: [
        `URL: ${url}`,
        `Header: Authorization: ${bearer}`,
        '',
        '# Check the connection (lists the tools):',
        `curl -s ${url} -H "Authorization: ${bearer}" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
      ].join('\n'),
    },
  ];
}
