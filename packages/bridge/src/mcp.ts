import { createInterface } from 'node:readline';

/**
 * A minimal Model Context Protocol server over stdio: newline-delimited JSON-RPC 2.0, the
 * `initialize` handshake, `tools/list` and `tools/call`. Only what a coding agent needs to call
 * the bridge's tools; no resources, prompts or sampling. Logging goes to stderr, never stdout.
 */

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export type ToolResult = { content: ToolContent[]; isError?: boolean };
export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call(args: Record<string, unknown>): Promise<ToolResult>;
}

type Request = { jsonrpc: '2.0'; id?: number | string | null; method: string; params?: Record<string, unknown> };
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export class McpServer {
  constructor(
    private readonly info: { name: string; version: string; instructions?: string },
    private readonly tools: Tool[],
    private readonly io: { input: NodeJS.ReadableStream; output: { write(s: string): unknown } } = { input: process.stdin, output: process.stdout },
  ) {}

  /** Serves until stdin ends. */
  async serve(): Promise<void> {
    const lines = createInterface({ input: this.io.input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let message: Request;
      try {
        message = JSON.parse(line) as Request;
      } catch {
        this.reply(null, undefined, { code: -32700, message: 'Parse error' });
        continue;
      }
      // Requests are answered in order of arrival; a tool call never blocks a later ping.
      void this.handle(message);
    }
  }

  async handle(message: Request): Promise<void> {
    const { id, method, params = {} } = message;
    if (id === undefined) return; // a notification (initialized, cancelled): nothing to answer
    try {
      switch (method) {
        case 'initialize': {
          const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
          const protocolVersion = SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0];
          this.reply(id, {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: this.info.name, version: this.info.version },
            ...(this.info.instructions ? { instructions: this.info.instructions } : {}),
          });
          return;
        }
        case 'ping':
          this.reply(id, {});
          return;
        case 'tools/list':
          this.reply(id, { tools: this.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
          return;
        case 'tools/call': {
          const name = typeof params.name === 'string' ? params.name : '';
          const tool = this.tools.find((t) => t.name === name);
          if (!tool) {
            this.reply(id, undefined, { code: -32602, message: `Unknown tool: ${name}` });
            return;
          }
          const args = params.arguments && typeof params.arguments === 'object' ? params.arguments as Record<string, unknown> : {};
          try {
            this.reply(id, await tool.call(args));
          } catch (error) {
            // Tool failures are results, not protocol errors, so the agent can read and react to them.
            this.reply(id, { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true });
          }
          return;
        }
        default:
          this.reply(id, undefined, { code: -32601, message: `Method not found: ${method}` });
      }
    } catch (error) {
      this.reply(id, undefined, { code: -32603, message: error instanceof Error ? error.message : 'Internal error' });
    }
  }

  private reply(id: number | string | null | undefined, result?: unknown, error?: { code: number; message: string }) {
    const body = error ? { jsonrpc: '2.0', id: id ?? null, error } : { jsonrpc: '2.0', id, result };
    this.io.output.write(JSON.stringify(body) + '\n');
  }
}
