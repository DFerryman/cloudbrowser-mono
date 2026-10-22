import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { basename, extname, resolve, sep } from 'node:path';
import { FILE_TRANSFER } from '@cloudbrowser/contracts';

/**
 * Local files the bridge may send to the browser: only inside the directories the user allowed
 * when starting the bridge (the working directory by default). A path is resolved to its real
 * location first, so a symbolic link cannot point outside. The upload tool is a way to hand the
 * agent's own files to a web page, never a way to widen what it may read.
 */
export class AllowedFiles {
  private readonly roots: Promise<string[]>;

  constructor(dirs: string[]) {
    this.roots = Promise.all(dirs.map((d) => realpath(resolve(d))));
  }

  async allowed(): Promise<string[]> {
    return this.roots;
  }

  /** The real path when it lies within an allowed directory and is a regular file; throws otherwise. */
  async check(path: string): Promise<{ path: string; name: string; size: number; type: string }> {
    const roots = await this.roots;
    let real: string;
    try {
      real = await realpath(resolve(path));
    } catch {
      throw new Error(`not found: ${path}`);
    }
    if (!roots.some((root) => real === root || real.startsWith(root.endsWith(sep) ? root : root + sep))) {
      throw new Error(`outside the allowed directories: ${path} (allowed: ${roots.join(', ')})`);
    }
    const info = await stat(real);
    if (!info.isFile()) throw new Error(`not a regular file: ${path}`);
    if (info.size > FILE_TRANSFER.maxBytes) throw new Error(`too large (${info.size} bytes; at most ${FILE_TRANSFER.maxBytes}): ${path}`);
    return { path: real, name: basename(real), size: info.size, type: mimeOf(real) };
  }

  /** Reads one checked file in base64 chunks of FILE_TRANSFER.chunkBytes. */
  async *chunks(path: string): AsyncGenerator<string> {
    const stream = createReadStream(path, { highWaterMark: FILE_TRANSFER.chunkBytes });
    let carry = Buffer.alloc(0);
    for await (const piece of stream) {
      carry = Buffer.concat([carry, piece as Buffer]);
      while (carry.length >= FILE_TRANSFER.chunkBytes) {
        yield carry.subarray(0, FILE_TRANSFER.chunkBytes).toString('base64');
        carry = carry.subarray(FILE_TRANSFER.chunkBytes);
      }
    }
    if (carry.length) yield carry.toString('base64');
  }
}

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
  '.zip': 'application/zip', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export const mimeOf = (path: string) => MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
