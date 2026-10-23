import { FILE_TRANSFER } from '@cloudbrowser/contracts';
import type { FileFrame, VmLink } from './vm-link.js';

/**
 * Stores one file in a coding-agent session's temporary area in the VM (docs/agent-access.md):
 * `file_begin` (action `store`), base64 `file_chunk`s of FILE_TRANSFER.chunkBytes and `file_end`,
 * the same framing a viewer's paste uses. At most FILE_TRANSFER.window chunks are ever ahead of the
 * VM's acknowledgements (its `file` progress frames), so a large upload never floods the tunnel or
 * holds up anything else on it. The SHA-256 of the bytes is computed while they stream.
 */

export class TransferFailed extends Error {
  constructor(readonly reason: string, readonly status: 400 | 502) {
    super(reason);
  }
}

export type Stored = { handle: string; name: string; size: number; sha256: string };

/** No acknowledgement (or final answer) from the VM for this long fails the transfer. */
export const ACK_TIMEOUT_MS = 30_000;

/** Base64 without spreading a whole chunk into one call's arguments. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array | null {
  const clean = text.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) return null;
  try {
    const binary = atob(clean);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Splits any byte stream into chunks of exactly `size` bytes (the last one shorter). */
async function* rechunk(source: AsyncIterable<Uint8Array>, size: number): AsyncGenerator<Uint8Array> {
  let buffer = new Uint8Array(size);
  let filled = 0;
  for await (const piece of source) {
    let offset = 0;
    while (offset < piece.length) {
      const n = Math.min(size - filled, piece.length - offset);
      buffer.set(piece.subarray(offset, offset + n), filled);
      filled += n;
      offset += n;
      if (filled === size) {
        yield buffer;
        buffer = new Uint8Array(size);
        filled = 0;
      }
    }
  }
  if (filled) yield buffer.subarray(0, filled);
}

/** A ReadableStream's chunks, released when the consumer stops early. */
export async function* streamBytes(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value?.length) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function* oneChunk(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

/**
 * Streams `source` (exactly `file.size` bytes) into the VM. Resolves with the handle the VM gave
 * the file; throws TransferFailed after telling the VM to drop what it received.
 */
export async function storeInVm(link: VmLink, id: string, file: { name: string; type: string; size: number }, source: AsyncIterable<Uint8Array>): Promise<Stored> {
  // Written by the VM's frames, read by the loop below.
  const vm: { acked: number; failure: TransferFailed | null; done: FileFrame | null; wake: (() => void) | null } = { acked: 0, failure: null, done: null, wake: null };
  const stop = link.watchTransfer(id, (frame) => {
    if (frame.status === 'progress') vm.acked++;
    else if (frame.status === 'done') vm.done = frame;
    else vm.failure = new TransferFailed(frame.reason ?? 'write_failed', 502);
    vm.wake?.();
  });
  /** Waits for the next frame of this transfer, failing on an error frame or a silent VM. */
  const next = () => new Promise<void>((resolve, reject) => {
    if (vm.failure) { reject(vm.failure); return; }
    const timer = setTimeout(() => { vm.wake = null; reject(new TransferFailed('timeout', 502)); }, ACK_TIMEOUT_MS);
    vm.wake = () => { clearTimeout(timer); vm.wake = null; if (vm.failure) reject(vm.failure); else resolve(); };
  });
  const digest = new crypto.DigestStream('SHA-256');
  const hashing = digest.getWriter();
  let sent = 0;
  let bytes = 0;
  try {
    if (!link.post({ t: 'file_begin', id, action: 'store', files: [file] })) throw new TransferFailed('relay_unavailable', 502);
    for await (const chunk of rechunk(source, FILE_TRANSFER.chunkBytes)) {
      bytes += chunk.length;
      if (bytes > file.size) throw new TransferFailed('length_mismatch', 400);
      while (sent - vm.acked >= FILE_TRANSFER.window) await next();
      if (vm.failure) throw vm.failure;
      await hashing.write(chunk);
      if (!link.post({ t: 'file_chunk', id, file: 0, chunk: toBase64(chunk) })) throw new TransferFailed('relay_unavailable', 502);
      sent++;
    }
    if (bytes !== file.size) throw new TransferFailed('length_mismatch', 400);
    while (vm.acked < sent) await next();
    if (!link.post({ t: 'file_end', id })) throw new TransferFailed('relay_unavailable', 502);
    while (!vm.done) await next();
    await hashing.close();
    const sha256 = [...new Uint8Array(await digest.digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const stored = vm.done.handles?.[0];
    if (!stored) throw new TransferFailed('write_failed', 502);
    return { handle: stored.handle, name: stored.name, size: stored.size, sha256 };
  } catch (error) {
    link.post({ t: 'file_cancel', id });
    await hashing.abort().catch(() => {});
    throw error instanceof TransferFailed ? error : new TransferFailed('upload_interrupted', 400);
  } finally {
    stop();
  }
}
