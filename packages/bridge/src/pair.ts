import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PairingGrant } from '@cloudbrowser/contracts';

/**
 * Pairing and the stored credential (docs/agent-access.md). The bridge redeems a one-time code at
 * the app's public `/api/automation/pair` endpoint for a long-lived credential, which it keeps in
 * the user's config directory at mode 0600. The credential is never printed and never passed to
 * the coding agent; only this file and the gateway ever hold it.
 */

export type StoredBridge = {
  app: string;
  gatewayUrl: string;
  credential: string;
  instanceId: string;
  instanceName: string;
  clientId: string;
  protocol: number;
};

export function configPath(): string {
  const base = process.env.CLOUDBROWSER_BRIDGE_HOME
    ?? (process.platform === 'win32' ? join(process.env.APPDATA ?? homedir(), 'cloudbrowser-bridge') : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'cloudbrowser-bridge'));
  return join(base, 'credentials.json');
}

export async function loadBridge(path = configPath()): Promise<StoredBridge | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as StoredBridge;
    return parsed.credential && parsed.gatewayUrl ? parsed : null;
  } catch {
    return null;
  }
}

export async function saveBridge(stored: StoredBridge, path = configPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(stored, null, 2), { mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
}

/** Redeems a pairing code; `fetchImpl` is injectable for tests. */
export async function redeem(appUrl: string, code: string, clientInfo: string, fetchImpl: typeof fetch = fetch): Promise<StoredBridge> {
  const url = `${appUrl.replace(/\/$/, '')}/api/automation/pair`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, client: clientInfo }),
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = await res.json() as { detail?: string; title?: string };
      detail = body.detail ?? body.title ?? detail;
    } catch { /* keep the status */ }
    throw new Error(res.status === 401 ? 'This pairing code is invalid, expired or already used. Create a new one in the browser\'s settings.' : `Pairing failed: ${detail}`);
  }
  const grant = await res.json() as PairingGrant;
  return {
    app: appUrl.replace(/\/$/, ''),
    gatewayUrl: grant.gatewayUrl,
    credential: grant.credential,
    instanceId: grant.instanceId,
    instanceName: grant.instanceName,
    clientId: grant.clientId,
    protocol: grant.protocol,
  };
}
