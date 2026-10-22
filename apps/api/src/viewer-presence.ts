export type ViewerPresence = { sequence: number; viewing: boolean | null };
type SessionIdentity = { id: string; instanceId: string; userId: string };

/**
 * Activity and presence advance in one transaction. In particular, a delayed visible report
 * cannot overtake a newer hidden report, and a replaced controller cannot renew the browser.
 * A visible heartbeat is a finite renewal of the ordinary idle deadline, never an infinite hold.
 */
export async function recordViewerHeartbeat(
  db: D1Database,
  session: SessionIdentity,
  input: boolean,
  presence: ViewerPresence | undefined,
  now: Date,
): Promise<{ active: boolean; lastInputAt: number | null }> {
  const at = now.getTime();
  const sequence = presence?.sequence ?? -1;
  const viewing = presence?.viewing === undefined || presence.viewing === null ? null : Number(presence.viewing);
  const active = 'id = ? AND instance_id = ? AND user_id = ? AND ended_at IS NULL';
  const identity = [session.id, session.instanceId, session.userId];
  const results = await db.batch([
    // Test the previous viewing value before updating it, inside the same D1 transaction.
    db.prepare(`INSERT INTO instance_health (instance_id, last_input_at)
      SELECT ?, ? WHERE EXISTS (SELECT 1 FROM viewer_sessions WHERE ${active}
        AND ((? < 0 AND ? = 1) OR (presence_seq < ? AND (? = 1 OR ? = 1 OR viewing = 1))))
      ON CONFLICT (instance_id) DO UPDATE SET last_input_at = max(coalesce(instance_health.last_input_at, 0), excluded.last_input_at)`)
      .bind(session.instanceId, at, ...identity, sequence, Number(input), sequence, Number(input), viewing),
    db.prepare(`UPDATE viewer_sessions SET
        last_seen_at = max(last_seen_at, ?),
        viewing = CASE WHEN presence_seq < ? THEN ? ELSE viewing END,
        presence_at = CASE WHEN presence_seq < ? THEN max(coalesce(presence_at, 0), ?) ELSE presence_at END,
        presence_seq = max(presence_seq, ?)
      WHERE ${active} AND (presence_seq < ? OR last_seen_at <= ?)`)
      .bind(at, sequence, viewing, sequence, at, sequence, ...identity, sequence, at - 60_000),
    db.prepare(`SELECT h.last_input_at FROM viewer_sessions s
      LEFT JOIN instance_health h ON h.instance_id = s.instance_id
      WHERE s.id = ? AND s.instance_id = ? AND s.user_id = ? AND s.ended_at IS NULL`)
      .bind(...identity),
  ]);
  const current = results[2]?.results?.[0] as { last_input_at: number | null } | undefined;
  return { active: !!current, lastInputAt: current?.last_input_at ?? null };
}

/** Ending an accepted visible view starts its idle countdown exactly once. */
export async function endViewerSession(db: D1Database, session: SessionIdentity, now: Date): Promise<void> {
  const at = now.getTime();
  const identity = [session.id, session.instanceId, session.userId];
  await db.batch([
    db.prepare(`INSERT INTO instance_health (instance_id, last_input_at)
      SELECT ?, ? WHERE EXISTS (SELECT 1 FROM viewer_sessions
        WHERE id = ? AND instance_id = ? AND user_id = ? AND ended_at IS NULL AND presence_seq >= 0 AND viewing = 1)
      ON CONFLICT (instance_id) DO UPDATE SET last_input_at = max(coalesce(instance_health.last_input_at, 0), excluded.last_input_at)`)
      .bind(session.instanceId, at, ...identity),
    db.prepare(`UPDATE viewer_sessions SET ended_at = ?,
        presence_at = CASE WHEN presence_seq >= 0 AND viewing = 1 THEN max(coalesce(presence_at, 0), ?) ELSE presence_at END,
        viewing = CASE WHEN presence_seq >= 0 THEN 0 ELSE viewing END
      WHERE id = ? AND instance_id = ? AND user_id = ? AND ended_at IS NULL`)
      .bind(at, at, ...identity),
  ]);
}
