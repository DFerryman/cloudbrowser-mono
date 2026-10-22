import { hostname, userInfo } from 'node:os';
import { AUTOMATION_PROTOCOL_VERSION } from '@cloudbrowser/contracts';
import { BridgeClient } from './client.js';
import { AllowedFiles } from './files.js';
import { McpServer } from './mcp.js';
import { configPath, loadBridge, redeem, saveBridge } from './pair.js';
import { createTools } from './tools.js';

/**
 * The bridge CLI (docs/agent-access.md). `pair` redeems a one-time code from the browser's
 * settings and stores a credential; `serve` is the MCP server a coding agent launches over stdio.
 * Logs go to stderr so they never corrupt the MCP stream on stdout.
 */

const USAGE = `cloudbrowser-bridge — connect a coding agent to a Nevazu cloud browser

  cloudbrowser-bridge pair --app <url> --code <code> [--name <label>]
      Redeem a pairing code from the browser's Settings → Coding agent access.
      Stores a credential in ${configPath()}.

  cloudbrowser-bridge serve [--allow <dir>]...
      Run the MCP server over stdio for your coding agent (Claude Code, Cursor, …).
      Tools: screenshot, act, upload_files, attach_files, get_status.
      Files can be uploaded only from the current directory, or any --allow <dir>.

  cloudbrowser-bridge status
      Show the paired browser and whether it can be reached.
`;

function parseFlags(args: string[]): { flags: Map<string, string[]>; rest: string[] } {
  const flags = new Map<string, string[]>();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const value = args[i + 1] && !args[i + 1]!.startsWith('--') ? args[++i]! : '';
      flags.set(key, [...(flags.get(key) ?? []), value]);
    } else rest.push(a);
  }
  return { flags, rest };
}

const log = (line: string) => process.stderr.write(`[cloudbrowser-bridge] ${line}\n`);

async function pair(flags: Map<string, string[]>): Promise<number> {
  const app = flags.get('app')?.[0];
  const code = flags.get('code')?.[0];
  if (!app || !code) { log('pair needs --app <url> and --code <code>'); return 2; }
  const name = flags.get('name')?.[0] || `${userInfo().username}@${hostname()}`;
  const stored = await redeem(app, code, name);
  await saveBridge(stored);
  log(`paired with "${stored.instanceName}". Credential saved to ${configPath()} (mode 0600).`);
  log('Add this to your coding agent as an MCP server: command "cloudbrowser-bridge", args ["serve"].');
  return 0;
}

async function status(): Promise<number> {
  const stored = await loadBridge();
  if (!stored) { log('not paired. Run: cloudbrowser-bridge pair --app <url> --code <code>'); return 1; }
  log(`paired with "${stored.instanceName}" (${stored.instanceId}) at ${stored.app}.`);
  const client = new BridgeClient({ gatewayUrl: stored.gatewayUrl, credential: stored.credential, onLog: log });
  try {
    await Promise.race([client.connect(), new Promise((_r, reject) => setTimeout(() => reject(new Error('timed out')), 15_000))]);
    const s = client.status;
    log(`reachable. browser agent online: ${s.agentOnline}; control mode: ${s.control.mode}.`);
    client.close();
    return 0;
  } catch (e) {
    log(`could not reach the browser: ${e instanceof Error ? e.message : String(e)}`);
    client.close();
    return 1;
  }
}

async function serve(flags: Map<string, string[]>): Promise<number> {
  const stored = await loadBridge();
  if (!stored) { log('not paired. Run: cloudbrowser-bridge pair --app <url> --code <code>'); return 1; }
  if (stored.protocol !== AUTOMATION_PROTOCOL_VERSION) log(`warning: this bridge speaks protocol ${AUTOMATION_PROTOCOL_VERSION}, the pairing was protocol ${stored.protocol}.`);
  const dirs = [process.cwd(), ...(flags.get('allow') ?? []).filter(Boolean)];
  const allowed = new AllowedFiles(dirs);
  log(`file uploads allowed from: ${(await allowed.allowed()).join(', ')}`);
  const client = new BridgeClient({ gatewayUrl: stored.gatewayUrl, credential: stored.credential, onLog: log, onControl: (c) => log(`control: ${c.controller} (mode ${c.mode})`) });
  await client.connect().catch((e) => { log(`could not connect: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; });
  if (process.exitCode) return 1;
  log(`connected to "${stored.instanceName}". Serving MCP over stdio.`);
  const server = new McpServer(
    { name: 'cloudbrowser-bridge', version: '0.1.0', instructions: `Drive the Nevazu cloud browser "${stored.instanceName}". Loop: call screenshot, read it, call act with coordinates from that screenshot, then screenshot again. The user watches live and can take control at any time; if an action is refused or interrupted, call get_status.` },
    createTools(client, allowed),
  );
  process.on('SIGINT', () => { client.close(); process.exit(0); });
  process.on('SIGTERM', () => { client.close(); process.exit(0); });
  await server.serve();
  client.close();
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  const { flags } = parseFlags(args);
  switch (command) {
    case 'pair': return pair(flags);
    case 'serve': return serve(flags);
    case 'status': return status();
    case 'help': case '--help': case '-h': case undefined: process.stderr.write(USAGE); return command ? 0 : 1;
    default: log(`unknown command: ${command}`); process.stderr.write(USAGE); return 2;
  }
}

// Run only as a program, not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => { log(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
