/** Connection evidence is deliberately limited to identifiers and fixed stage/error names.
 * Never pass URLs, token claims, SDP, input payloads or exception messages to these logs. */
export type ConnectionIdentity = {
  instanceId?: string;
  generation?: number | null;
  sessionId?: string;
  relayId?: string;
  attemptId?: string;
};

type ConnectionEvidence = ConnectionIdentity & {
  role?: 'agent' | 'viewer' | 'automation';
  code?: string;
  event?: string;
  elapsedMs?: number;
  closeCode?: number;
  wasClean?: boolean;
  status?: number;
  ignored?: boolean;
  discardReason?: 'stale_relay';
};

const identifier = (value: string | undefined) => value && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
const label = (value: string | undefined) => value && /^[a-z][a-z0-9_/]{0,63}$/.test(value) ? value : undefined;

export function connectionAttempt(value: string | null | undefined): string | undefined {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : undefined;
}

export function connectionLog(stage: string, fields: ConnectionEvidence): void {
  console.info('connection stage', {
    stage,
    instanceId: identifier(fields.instanceId),
    generation: typeof fields.generation === 'number' && Number.isSafeInteger(fields.generation) ? fields.generation : undefined,
    sessionId: identifier(fields.sessionId),
    relayId: connectionAttempt(fields.relayId),
    attemptId: connectionAttempt(fields.attemptId),
    role: fields.role,
    code: label(fields.code),
    event: label(fields.event),
    elapsedMs: typeof fields.elapsedMs === 'number' && Number.isSafeInteger(fields.elapsedMs) && fields.elapsedMs >= 0 ? fields.elapsedMs : undefined,
    closeCode: typeof fields.closeCode === 'number' && Number.isSafeInteger(fields.closeCode) ? fields.closeCode : undefined,
    wasClean: fields.wasClean,
    status: fields.status,
    ignored: fields.ignored,
    discardReason: fields.discardReason,
  });
}
