/**
 * Connecting a coding agent to a browser's hosted MCP endpoint (docs/agent-access.md). Nothing is
 * installed, and the agent configures itself: the user saves the access key in an environment
 * variable and hands the agent a short setup (agentHandoff) with a standard MCP configuration and
 * the per-client steps (/docs/agent-setup), which the agent follows for whichever client it is.
 * Every client below refers to the variable, so the key never passes through the agent's chat or
 * lands in its configuration.
 *
 * Signing in (OAuth) needs no key at all: the configuration is the URL alone, the client finds the
 * sign-in from the server's answer, and the owner approves it on nevazu.com (signInHandoff,
 * signInSetups).
 */

/** The steps for each client, as markdown an agent can read (the docs article "agent-setup"). */
export const SETUP_GUIDE_URL = 'https://nevazu.com/docs/agent-setup.md';

export type AgentClient = 'claude-code' | 'codex' | 'cursor' | 'vscode' | 'windsurf' | 'gemini' | 'opencode' | 'other';

export interface AgentSetup {
  client: AgentClient;
  label: string;
  /** Where the snippet goes: a terminal, or a configuration file's usual path. */
  where: string;
  code: string;
}

/** What a browser's setup is made of: the server's name, its URL and the variable holding the key. */
export interface AgentServer {
  name: string;
  url: string;
  env: string;
}

const slug = (browserName: string) =>
  browserName.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');

/** The server's name in the agent's configuration: one per browser, so several can coexist. */
export function serverName(browserName: string): string {
  return `nevazu-${slug(browserName) || 'browser'}`;
}

/** The environment variable holding the browser's key: one per browser, like the server name. */
export function keyEnvName(browserName: string): string {
  return `${serverName(browserName).toUpperCase().replace(/-/g, '_')}_KEY`;
}

export function agentServer({ url, browserName }: { url: string; browserName: string }): AgentServer {
  return { name: serverName(browserName), url, env: keyEnvName(browserName) };
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

/** The configuration most agents read or can translate: `mcpServers`, with the key as `${VAR}`. */
export function mcpConfig({ name, url, env }: AgentServer): string {
  return json({ mcpServers: { [name]: { type: 'http', url, headers: { Authorization: `Bearer \${${env}}` } } } });
}

/** What the user pastes into their agent: everything it needs to configure itself, but the key. */
export function agentHandoff(server: AgentServer, browserName: string): string {
  const label = browserName.replace(/\s+/g, ' ').trim();
  return [
    `Add my Nevazu cloud browser "${label}" to your own MCP configuration as a remote server (Streamable HTTP), so you can use it from now on. The configuration, in the standard mcpServers format:`,
    '',
    mcpConfig(server),
    '',
    `Follow the steps for your client (Claude Code, Codex, Cursor, VS Code, Windsurf, Gemini CLI, OpenCode or any other MCP client): ${SETUP_GUIDE_URL}`,
    '',
    `The access key is in the environment variable ${server.env}, which I set myself. Refer to the variable as those steps show; never ask me for the key, print it, or write its value into a file. When you are done, tell me if you must be restarted to load the server, and once it is loaded, check the connection with its get_status tool.`,
  ].join('\n');
}

/** Saving a just-created key where agents read it: the user's own step, for the shell they use. */
export function keyEnvCommands(env: string, key: string): { unix: string; windows: string } {
  return {
    unix: [
      '# zsh (macOS). With bash, use ~/.bashrc instead of ~/.zshrc.',
      `echo 'export ${env}="${key}"' >> ~/.zshrc`,
    ].join('\n'),
    windows: [
      '# PowerShell or Command Prompt',
      `setx ${env} "${key}"`,
    ].join('\n'),
  };
}

/** The per-client steps, each reading the key from the server's variable. */
export function agentSetups(server: AgentServer): AgentSetup[] {
  const { name, url, env } = server;
  return [
    {
      client: 'claude-code',
      label: 'Claude Code',
      where: 'Terminal',
      // Single quotes keep ${VAR} as written: Claude Code expands it each time it starts.
      code: `claude mcp add-json --scope user ${name} '${JSON.stringify({ type: 'http', url, headers: { Authorization: `Bearer \${${env}}` } })}'`,
    },
    {
      client: 'codex',
      label: 'Codex',
      where: '~/.codex/config.toml',
      code: [`[mcp_servers.${name}]`, `url = "${url}"`, `bearer_token_env_var = "${env}"`, 'tool_timeout_sec = 90'].join('\n'),
    },
    {
      client: 'cursor',
      label: 'Cursor',
      where: '~/.cursor/mcp.json',
      code: json({ mcpServers: { [name]: { url, headers: { Authorization: `Bearer \${env:${env}}` } } } }),
    },
    {
      client: 'vscode',
      label: 'VS Code',
      where: 'MCP: Open User Configuration',
      // VS Code asks for the key once and keeps it in its secret storage, never in the file.
      code: json({
        inputs: [{ type: 'promptString', id: `${name}-key`, description: `Nevazu access key (${env})`, password: true }],
        servers: { [name]: { type: 'http', url, headers: { Authorization: `Bearer \${input:${name}-key}` } } },
      }),
    },
    {
      client: 'windsurf',
      label: 'Windsurf',
      where: '~/.codeium/windsurf/mcp_config.json',
      code: json({ mcpServers: { [name]: { serverUrl: url, headers: { Authorization: `Bearer \${env:${env}}` } } } }),
    },
    {
      client: 'gemini',
      label: 'Gemini CLI',
      where: '~/.gemini/settings.json',
      code: json({ mcpServers: { [name]: { httpUrl: url, headers: { Authorization: `Bearer \${${env}}` } } } }),
    },
    {
      client: 'opencode',
      label: 'OpenCode',
      where: '~/.config/opencode/opencode.json',
      code: json({ $schema: 'https://opencode.ai/config.json', mcp: { [name]: { type: 'remote', url, enabled: true, oauth: false, headers: { Authorization: `Bearer {env:${env}}` } } } }),
    },
    {
      client: 'other',
      label: 'Other',
      where: 'Any MCP client (Streamable HTTP)',
      code: [
        `URL: ${url}`,
        `Header: Authorization: Bearer <the value of ${env}>`,
        '',
        '# Check the key (lists the tools):',
        `curl -s ${url} -H "Authorization: Bearer $${env}" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
      ].join('\n'),
    },
  ];
}

// --- signing in instead of a key ---------------------------------------------------------------

/** Clients set up for signing in; the Claude apps (claude.ai, Desktop) add a connector by URL. */
export type SignInClient = AgentClient | 'claude-app';

export interface SignInSetup {
  client: SignInClient;
  label: string;
  where: string;
  code: string;
}

/** The configuration for signing in: the URL alone, no header. */
export function signInConfig({ name, url }: AgentServer): string {
  return json({ mcpServers: { [name]: { type: 'http', url } } });
}

/** What the user pastes into their agent to sign it in: the server, the steps, and who approves. */
export function signInHandoff(server: AgentServer, browserName: string): string {
  const label = browserName.replace(/\s+/g, ' ').trim();
  return [
    `Add my Nevazu cloud browser "${label}" to your own MCP configuration as a remote server (Streamable HTTP), so you can use it from now on. It needs no key: you sign in with my Nevazu account (OAuth) and I approve it. The configuration, in the standard mcpServers format:`,
    '',
    signInConfig(server),
    '',
    `Follow the sign-in steps for your client (Claude Code, Codex, Cursor, VS Code, Windsurf, Gemini CLI, OpenCode or any other MCP client), in the section "Signing in instead of a key": ${SETUP_GUIDE_URL}`,
    '',
    'Do not add an Authorization header or ask me for a key. Once the server is added, start its sign-in, or tell me the command or button that starts it if only I can. A Nevazu page opens in my web browser, where I approve it and choose how long it lasts. Then check the connection with its get_status tool.',
  ].join('\n');
}

/** The per-client steps for signing in: the server by URL, then the client's own sign-in. */
export function signInSetups(server: AgentServer): SignInSetup[] {
  const { name, url } = server;
  return [
    { client: 'claude-code', label: 'Claude Code', where: 'Terminal', code: `claude mcp add --transport http --scope user ${name} ${url}` },
    { client: 'claude-app', label: 'Claude app', where: 'Settings → Connectors → Add custom connector', code: url },
    {
      client: 'codex',
      label: 'Codex',
      where: '~/.codex/config.toml',
      code: [`[mcp_servers.${name}]`, `url = "${url}"`, 'tool_timeout_sec = 90', '', `# Then sign in from a terminal: codex mcp login ${name}`].join('\n'),
    },
    { client: 'cursor', label: 'Cursor', where: '~/.cursor/mcp.json', code: json({ mcpServers: { [name]: { url } } }) },
    { client: 'vscode', label: 'VS Code', where: 'MCP: Open User Configuration', code: json({ servers: { [name]: { type: 'http', url } } }) },
    { client: 'windsurf', label: 'Windsurf', where: '~/.codeium/windsurf/mcp_config.json', code: json({ mcpServers: { [name]: { serverUrl: url } } }) },
    { client: 'gemini', label: 'Gemini CLI', where: '~/.gemini/settings.json', code: json({ mcpServers: { [name]: { httpUrl: url } } }) },
    {
      client: 'opencode',
      label: 'OpenCode',
      where: '~/.config/opencode/opencode.json',
      code: json({ $schema: 'https://opencode.ai/config.json', mcp: { [name]: { type: 'remote', url, enabled: true } } }),
    },
    {
      client: 'other',
      label: 'Other',
      where: 'Any MCP client (Streamable HTTP)',
      code: [`URL: ${url}`, 'No header: the client signs in with OAuth (MCP authorization), which it discovers from the server.'].join('\n'),
    },
  ];
}
