/** Drizzle wraps the actionable D1 error in Error.cause. Bound traversal also handles cycles. */
export function errorMessages(error: unknown): string[] {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  for (let current = error; current != null && !seen.has(current) && messages.length < 8;) {
    seen.add(current);
    messages.push(current instanceof Error ? current.message : String(current));
    // Several independent failures (a cron round): list each one's own message too.
    if (current instanceof AggregateError) for (const inner of current.errors.slice(0, 8)) messages.push(...errorMessages(inner).map((m) => `  ${m}`));
    current = current instanceof Error ? current.cause : undefined;
  }
  return messages;
}

/** D1's own transient failures (Cloudflare resetting or moving the database), which a later attempt survives. */
export function transientD1(error: unknown): boolean {
  return errorMessages(error).some((message) =>
    /network connection lost|replica disconnected from primary|D1 DB reset because its code was updated|internal error (?:while starting up|in) D1 DB storage caused object to be reset|cannot resolve D1 DB due to transient issue on remote node|D1 DB is overloaded/i.test(message));
}

/** Only use for idempotent statements, never replay an entire billing transaction. */
export async function retryD1<T>(run: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!transientD1(error) || attempt >= 2) throw error;
      await sleep(100 * 2 ** attempt);
    }
  }
}
