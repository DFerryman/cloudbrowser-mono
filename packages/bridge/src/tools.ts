import { randomUUID } from 'node:crypto';
import { AUTOMATION_LIMITS, ActionStep, type AutomationRequest } from '@cloudbrowser/contracts';
import type { BridgeClient, RequestOutcome } from './client.js';
import { AllowedFiles } from './files.js';
import type { Tool, ToolContent, ToolResult } from './mcp.js';

/**
 * The tools the bridge offers a coding agent (docs/agent-access.md, section 3). Each one builds an
 * automation request, sends it through the gateway and turns the result into MCP content. The
 * agent's loop is: screenshot → decide → act → screenshot again; `act` returns the next screenshot
 * with its result so that loop is one call per step.
 */

const rid = () => randomUUID().replace(/-/g, '').slice(0, 24);

/** Stored-file handles from this session, so `attach_files` can name them (handle → name). */
export class FileStore {
  private readonly names = new Map<string, string>();
  remember(handle: string, name: string) { this.names.set(handle, name); }
  name(handle: string) { return this.names.get(handle); }
  known(handle: string) { return this.names.has(handle); }
}

function screenshotContent(outcome: RequestOutcome): ToolContent[] {
  const content: ToolContent[] = [];
  const r = outcome.result;
  const lines = [`status: ${r.status}`];
  if (r.reason) lines.push(`reason: ${r.reason}`);
  if (r.stoppedAt !== undefined) lines.push(`stopped at step ${r.stoppedAt}`);
  lines.push(`control: ${r.control.controller} may act (mode ${r.control.mode}, epoch ${r.control.epoch})`);
  lines.push(`screen: ${r.screen.width}x${r.screen.height} (version ${r.screen.version})`);
  if (outcome.image) {
    lines.push(`screenshot ${outcome.image.id}: ${outcome.image.width}x${outcome.image.height}, taken ${outcome.image.capturedAt}`);
    if (r.control.mode === 'user') lines.push('note: the user has taken control; input is refused until they hand it back.');
    if (r.control.mode === 'privacy') lines.push('note: privacy pause is on; no screenshot is available.');
    content.push({ type: 'image', data: outcome.image.base64, mimeType: outcome.image.mime });
  } else if (r.control.mode === 'privacy') {
    lines.push('no screenshot: privacy pause is on.');
  }
  content.unshift({ type: 'text', text: lines.join('\n') });
  return content;
}

const text = (s: string): ToolResult => ({ content: [{ type: 'text', text: s }] });

/**
 * A refused or failed request becomes a readable error result, not a thrown exception: a refusal
 * (the user holds control, privacy pause, access off) is information the agent should read and
 * react to, often by calling get_status, rather than a crash.
 */
function refusalResult(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const hint = message.startsWith('refused: control_user') ? ' The user has taken control; wait for them to hand it back.'
    : message.startsWith('refused: control_privacy') ? ' Privacy pause is on; the user is working privately.'
      : message.startsWith('refused: agent_access_off') ? ' Coding agent access was turned off for this browser.'
        : message.startsWith('refused: relay_unavailable') ? ' The browser is not reachable right now; it may be waking or reconnecting.'
          : '';
  return { content: [{ type: 'text', text: message + hint }], isError: true };
}

export function createTools(client: BridgeClient, allowed: AllowedFiles): Tool[] {
  const store = new FileStore();

  const screenshot: Tool = {
    name: 'screenshot',
    description: 'Capture the browser\'s whole screen (tabs, address bar, menus and any dialog) as a JPEG, with its coordinate size and who currently controls the browser. Coordinates for act are pixels of this image. Capturing never changes focus or layout.',
    inputSchema: { type: 'object', properties: { quality: { type: 'integer', minimum: 10, maximum: 100, description: 'JPEG quality 10-100 (default 85).' } } },
    async call(args) {
      const quality = typeof args.quality === 'number' ? args.quality : undefined;
      try {
        const outcome = await client.request({ t: 'screenshot', id: rid(), quality });
        return { content: screenshotContent(outcome), isError: outcome.result.status !== 'executed' };
      } catch (error) {
        return refusalResult(error);
      }
    },
  };

  const act: Tool = {
    name: 'act',
    description: [
      'Run one or more input steps in order, then return a fresh screenshot with the result.',
      'Steps: move {x,y}; click {x?,y?,button?,count?,modifiers?}; button {down,x?,y?,button?}; drag {path:[{x,y}...],button?,modifiers?}; scroll {x?,y?,deltaX?,deltaY?,modifiers?} (positive deltaY scrolls down); key {keys:[...]} (a chord like ["Control","l"]); keyhold {key,down}; type {text} (no Enter is added); paste {text}; wait {ms}.',
      'Pass screenshotId from the screenshot the coordinates came from; the browser refuses the call if the screen changed since. If the user takes control the call returns status "interrupted".',
    ].join(' '),
    inputSchema: {
      type: 'object',
      required: ['steps'],
      properties: {
        steps: { type: 'array', minItems: 1, maxItems: AUTOMATION_LIMITS.maxSteps, description: 'The input steps, run in order.', items: { type: 'object' } },
        screenshotId: { type: 'string', description: 'The id of the screenshot the coordinates were read from.' },
        settleMs: { type: 'integer', minimum: 0, maximum: AUTOMATION_LIMITS.maxWaitMs, description: 'Wait this long after the last step before the screenshot (default 400).' },
        screenshot: { type: 'boolean', description: 'Return a screenshot with the result (default true).' },
        quality: { type: 'integer', minimum: 10, maximum: 100 },
      },
    },
    async call(args) {
      const steps = Array.isArray(args.steps) ? args.steps : [];
      const parsed = steps.map((s) => ActionStep.safeParse(s));
      const bad = parsed.findIndex((p) => !p.success);
      if (bad >= 0) return { content: [{ type: 'text', text: `step ${bad} is not valid: ${parsed[bad]!.success ? '' : parsed[bad]!.error.issues.map((i) => i.message).join(', ')}` }], isError: true };
      const req: AutomationRequest = {
        t: 'act', id: rid(), steps: parsed.map((p) => p.success && p.data) as never,
        ...(typeof args.screenshotId === 'string' ? { screenshotId: args.screenshotId, screenVersion: undefined } : {}),
        ...(typeof args.settleMs === 'number' ? { settleMs: args.settleMs } : {}),
        ...(args.screenshot === false ? { screenshot: false } : {}),
        ...(typeof args.quality === 'number' ? { quality: args.quality } : {}),
      };
      try {
        const outcome = await client.request(req);
        return { content: screenshotContent(outcome), isError: !['executed', 'interrupted'].includes(outcome.result.status) };
      } catch (error) {
        return refusalResult(error);
      }
    },
  };

  const upload_files: Tool = {
    name: 'upload_files',
    description: 'Copy local files from the bridge\'s allowed directories into the browser\'s temporary storage and return a handle for each. This does not touch any web page; use attach_files to deliver them. Paths must be inside the directories the bridge was started with.',
    inputSchema: {
      type: 'object', required: ['paths'],
      properties: { paths: { type: 'array', minItems: 1, maxItems: AUTOMATION_LIMITS ? 10 : 10, items: { type: 'string' }, description: 'Local file paths to upload.' } },
    },
    async call(args) {
      const paths = Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === 'string') : [];
      if (!paths.length) return { content: [{ type: 'text', text: 'Give at least one path.' }], isError: true };
      const files = [];
      for (const p of paths) files.push(await allowed.check(p)); // throws for a path outside the allowed dirs
      const id = rid();
      const done = new Promise<ToolResult>((resolve, reject) => {
        client.onFile(id, (frame) => {
          if (frame.status === 'error') { client.offFile(id); reject(new Error(`upload failed: ${frame.reason ?? 'unknown'}`)); }
          else if (frame.status === 'done') {
            client.offFile(id);
            for (const h of frame.handles ?? []) store.remember(h.handle, h.name);
            resolve(text((frame.handles ?? []).map((h) => `${h.handle}  ${h.name} (${h.size} bytes)`).join('\n') || 'stored'));
          }
        });
      });
      client.send({ t: 'file_begin', id, action: 'store', files: files.map((f) => ({ name: f.name, type: f.type, size: f.size })) });
      for (let i = 0; i < files.length; i++) {
        for await (const chunk of allowed.chunks(files[i]!.path)) client.send({ t: 'file_chunk', id, file: i, chunk });
      }
      client.send({ t: 'file_end', id });
      return done;
    },
  };

  const attach_files: Tool = {
    name: 'attach_files',
    description: 'Deliver already-uploaded files to the page: method "picker" fills Chrome\'s open file dialog, "paste" puts them on the clipboard and presses Ctrl+V into the focused field, "drop" drops them at a point (x,y in screenshot pixels). Needs control of the browser; returns a screenshot of the result.',
    inputSchema: {
      type: 'object', required: ['handles', 'method'],
      properties: {
        handles: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Handles from upload_files.' },
        method: { type: 'string', enum: ['picker', 'paste', 'drop'] },
        x: { type: 'integer' }, y: { type: 'integer' },
        screenshot: { type: 'boolean' },
      },
    },
    async call(args) {
      const handles = Array.isArray(args.handles) ? args.handles.filter((h): h is string => typeof h === 'string') : [];
      const method = args.method;
      if (!handles.length || (method !== 'picker' && method !== 'paste' && method !== 'drop')) return { content: [{ type: 'text', text: 'Give handles and a method of picker, paste or drop.' }], isError: true };
      const unknown = handles.filter((h) => !store.known(h));
      if (unknown.length) return { content: [{ type: 'text', text: `unknown handles (upload them first): ${unknown.join(', ')}` }], isError: true };
      try {
        const outcome = await client.request({
          t: 'attach', id: rid(), handles, method,
          ...(method === 'drop' ? { x: Number(args.x) || 0, y: Number(args.y) || 0 } : {}),
          ...(args.screenshot === false ? { screenshot: false } : {}),
        });
        return { content: screenshotContent(outcome), isError: outcome.result.status !== 'executed' };
      } catch (error) {
        return refusalResult(error);
      }
    },
  };

  const get_status: Tool = {
    name: 'get_status',
    description: 'Report the connection to the browser, whether its agent is online, and who may drive it right now (agent, or the user after a takeover). Call this when an action was refused or interrupted to see why.',
    inputSchema: { type: 'object', properties: {} },
    async call() {
      const s = client.status;
      const outcome = await client.request({ t: 'status', id: rid() }).catch(() => null);
      const control = outcome?.result.control ?? s.control;
      const caps = outcome?.result.capabilities;
      const lines = [
        `connected: ${s.connected}`,
        `browser agent online: ${s.agentOnline}`,
        `control: ${control.controller} (mode ${control.mode}, epoch ${control.epoch})`,
        control.mode === 'user' ? 'The user has taken control; your input is refused until they hand it back in the live view.' :
          control.mode === 'privacy' ? 'Privacy pause is on; screenshots and input are withheld until the user ends it.' :
            'You may act.',
      ];
      if (outcome?.result.activeActionId) lines.push(`an act is still running: ${outcome.result.activeActionId}`);
      if (caps) lines.push(`screen ${outcome!.result.screen.width}x${outcome!.result.screen.height}; files ${caps.files ? 'on' : 'off'} (picker ${caps.picker}, paste ${caps.paste}, drop ${caps.drop})`);
      return text(lines.join('\n'));
    },
  };

  return [screenshot, act, upload_files, attach_files, get_status];
}
