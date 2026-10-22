/**
 * Files a viewer pasted or dropped, or a coding agent's bridge stored. They travel to the VM as
 * ordered base64 chunks on the sender's socket, each file's bytes in order; the agent acknowledges
 * what it wrote, and the sender keeps only a few chunks unacknowledged so the gateway's input
 * queue never fills. Its own module: protocol.ts and automation.ts both need it.
 */
export const FILE_TRANSFER = {
  maxFiles: 10,
  maxBytes: 50 * 1024 * 1024,
  chunkBytes: 96 * 1024,
  /** Chunks sent ahead of the agent's acknowledgement. */
  window: 3,
} as const;
