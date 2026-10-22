/** Unknown visibility retains the input-only policy. Focus/blur is not page visibility. */
export function viewingPresence(visibility: unknown, live: boolean, displaying: boolean): boolean | null {
  if (visibility !== 'visible' && visibility !== 'hidden') return null;
  return visibility === 'visible' && live && displaying;
}

export interface SessionHeartbeatBody {
  input: boolean;
  presence: { sequence: number; viewing: boolean | null };
}

/** One bounded request at a time; visibility changes flush the latest state after any pending send. */
export function sessionHeartbeat<T>(options: {
  takeInput(): boolean;
  viewing(): boolean | null;
  nextSequence(): number;
  send(body: SessionHeartbeatBody, signal: AbortSignal): Promise<T>;
  result(value: T): void;
  error(error: unknown): void;
}) {
  let disposed = false;
  let pending = false;
  let active: AbortController | null = null;
  // Retry recent input briefly, without making one lost response renew inactivity forever.
  let inputUntil = 0;
  const refresh = () => {
    if (disposed) return;
    if (active) { pending = true; return; }
    const controller = new AbortController();
    active = controller;
    if (options.takeInput()) inputUntil = Date.now() + 30_000;
    const input = inputUntil > Date.now();
    const reportedInputUntil = inputUntil;
    const body = { input, presence: { sequence: options.nextSequence(), viewing: options.viewing() } };
    const canceled = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('Session heartbeat timed out or ended')), { once: true });
    });
    const timeout = setTimeout(() => controller.abort(), 5_000);
    void Promise.race([Promise.resolve().then(() => options.send(body, controller.signal)), canceled])
      .then((value) => {
        if (disposed) return;
        if (inputUntil === reportedInputUntil) inputUntil = 0;
        options.result(value);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        options.error(error);
      })
      .finally(() => {
        clearTimeout(timeout);
        active = null;
        if (!disposed && pending) { pending = false; refresh(); }
      });
  };
  const interval = setInterval(refresh, 15_000);
  refresh();
  return {
    refresh,
    dispose() {
      disposed = true;
      pending = false;
      clearInterval(interval);
      active?.abort();
    },
  };
}
