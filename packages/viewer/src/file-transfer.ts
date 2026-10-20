import { FILE_TRANSFER } from '@cloudbrowser/contracts';

export type TransferAction = 'paste' | 'drop';

/** What a transfer is doing, for the page to show. `reason` names why one failed. */
export interface TransferUpdate {
  id: string;
  action: TransferAction;
  files: number;
  bytes: number;
  /** Bytes the browser has received. */
  received: number;
  state: 'uploading' | 'done' | 'error';
  reason?: string;
}

/** A File, or anything with its name, type, size and a byte slice. */
export interface TransferFile {
  name: string;
  type: string;
  size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

type Frame =
  | { t: 'file_begin'; id: string; action: TransferAction; x?: number; y?: number; files: { name: string; type: string; size: number }[] }
  | { t: 'file_chunk'; id: string; file: number; chunk: string }
  | { t: 'file_end'; id: string }
  | { t: 'file_cancel'; id: string };

export interface FileTransferOptions {
  /** Sends a frame on the viewer socket; false when it is not open. */
  send: (frame: Frame) => boolean;
  onUpdate?: (update: TransferUpdate) => void;
  /** A paste's files are on the remote clipboard: send Ctrl+V. */
  onPasteReady?: () => void;
  /** A browser that stops answering (or runs an agent without transfers) fails after this long. */
  timeoutMs?: number;
  chunkBytes?: number;
  window?: number;
}

const TIMEOUT_MS = 20_000;

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

interface Transfer {
  update: TransferUpdate;
  files: TransferFile[];
  /** Bytes handed to the socket. */
  sent: number;
  sending: boolean;
  ended: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Sends pasted or dropped files to the remote browser (contracts FILE_TRANSFER): `file_begin`,
 * each file's bytes in order as base64 chunks, then `file_end`. The agent acknowledges what it
 * wrote; at most `window` chunks are unacknowledged, so the gateway's bounded input queue never
 * fills. The agent answers `done` once the files are on the remote clipboard (paste) or dropped.
 */
export class FileTransfers {
  private readonly transfers = new Map<string, Transfer>();
  private sequence = 0;

  constructor(private readonly opts: FileTransferOptions) {}

  /** Starts a transfer; returns its id, or null (reported through onUpdate) when it is refused. */
  start(action: TransferAction, files: TransferFile[], point?: { x: number; y: number }): string | null {
    const id = `${Date.now().toString(36)}-${(++this.sequence).toString(36)}`;
    const bytes = files.reduce((sum, f) => sum + f.size, 0);
    const update: TransferUpdate = { id, action, files: files.length, bytes, received: 0, state: 'uploading' };
    const refuse = (reason: string) => {
      this.opts.onUpdate?.({ ...update, state: 'error', reason });
      return null;
    };
    if (files.length === 0) return null;
    if (files.length > FILE_TRANSFER.maxFiles) return refuse('too_many');
    if (bytes > FILE_TRANSFER.maxBytes) return refuse('too_large');
    const begin: Frame = {
      t: 'file_begin', id, action,
      ...(point ? { x: Math.max(0, Math.round(point.x)), y: Math.max(0, Math.round(point.y)) } : {}),
      files: files.map((f) => ({ name: (f.name || 'file').slice(0, 255), type: f.type.slice(0, 255), size: f.size })),
    };
    if (!this.opts.send(begin)) return refuse('disconnected');
    const transfer: Transfer = { update, files, sent: 0, sending: false, ended: false, timer: null };
    this.transfers.set(id, transfer);
    this.opts.onUpdate?.({ ...update });
    this.arm(transfer);
    void this.pump(transfer);
    return id;
  }

  /** An agent's `file` frame. */
  handle(frame: { id: string; status: 'progress' | 'done' | 'error'; received?: number; reason?: string }) {
    const transfer = this.transfers.get(frame.id);
    if (!transfer) return;
    if (frame.status === 'error') {
      this.finish(transfer, 'error', frame.reason ?? 'failed');
      return;
    }
    if (frame.status === 'done') {
      transfer.update.received = transfer.update.bytes;
      this.finish(transfer, 'done');
      if (transfer.update.action === 'paste') this.opts.onPasteReady?.();
      return;
    }
    if (typeof frame.received === 'number' && frame.received > transfer.update.received) {
      transfer.update.received = frame.received;
      this.opts.onUpdate?.({ ...transfer.update });
    }
    this.arm(transfer);
    void this.pump(transfer);
  }

  /** The socket closed: every transfer in flight is lost; the agent discards its part. */
  failAll(reason = 'disconnected') {
    for (const transfer of [...this.transfers.values()]) this.finish(transfer, 'error', reason);
  }

  private finish(transfer: Transfer, state: 'done' | 'error', reason?: string) {
    if (transfer.timer) clearTimeout(transfer.timer);
    this.transfers.delete(transfer.update.id);
    transfer.update.state = state;
    if (reason) transfer.update.reason = reason;
    this.opts.onUpdate?.({ ...transfer.update });
  }

  private arm(transfer: Transfer) {
    if (transfer.timer) clearTimeout(transfer.timer);
    transfer.timer = setTimeout(() => {
      this.opts.send({ t: 'file_cancel', id: transfer.update.id });
      this.finish(transfer, 'error', 'timeout');
    }, this.opts.timeoutMs ?? TIMEOUT_MS);
  }

  private async pump(transfer: Transfer) {
    if (transfer.sending) return;
    transfer.sending = true;
    const chunk = this.opts.chunkBytes ?? FILE_TRANSFER.chunkBytes;
    const ahead = chunk * (this.opts.window ?? FILE_TRANSFER.window);
    try {
      while (this.transfers.get(transfer.update.id) === transfer && transfer.sent < transfer.update.bytes
        && transfer.sent - transfer.update.received < ahead) {
        // Locate the next chunk: files go in order, and a chunk never spans two of them.
        let offset = transfer.sent;
        let file = 0;
        while (offset >= transfer.files[file]!.size) offset -= transfer.files[file++]!.size;
        const source = transfer.files[file]!;
        const end = Math.min(source.size, offset + chunk);
        const bytes = new Uint8Array(await source.slice(offset, end).arrayBuffer());
        if (this.transfers.get(transfer.update.id) !== transfer) return;
        if (bytes.length !== end - offset) {
          this.opts.send({ t: 'file_cancel', id: transfer.update.id });
          this.finish(transfer, 'error', 'read_failed');
          return;
        }
        if (!this.opts.send({ t: 'file_chunk', id: transfer.update.id, file, chunk: toBase64(bytes) })) {
          this.finish(transfer, 'error', 'disconnected');
          return;
        }
        transfer.sent += bytes.length;
      }
      if (transfer.sent === transfer.update.bytes && !transfer.ended && this.transfers.get(transfer.update.id) === transfer) {
        transfer.ended = true;
        if (!this.opts.send({ t: 'file_end', id: transfer.update.id })) this.finish(transfer, 'error', 'disconnected');
      }
    } catch {
      this.opts.send({ t: 'file_cancel', id: transfer.update.id });
      this.finish(transfer, 'error', 'read_failed');
    } finally {
      transfer.sending = false;
    }
  }
}

/**
 * What a paste carries: files copied in a file manager, or an image (a screenshot, an image copied
 * from a page) unless text came with it (a spreadsheet's cells come with a picture of themselves).
 */
export function pastedFiles<T extends TransferFile>(files: T[], text: string): T[] {
  if (files.length === 0) return [];
  // Browsers name clipboard images image.png; a file from a file manager keeps its own name.
  const copiedFiles = files.some((f) => !(f.type.startsWith('image/') && /^image\.\w+$/.test(f.name)));
  return copiedFiles || !text ? files : [];
}
