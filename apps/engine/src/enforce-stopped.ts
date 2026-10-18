import { schema } from '@cloudbrowser/db';
import type { ExecutorKind } from '@cloudbrowser/executors';
import { and, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import { readContext, type EngineDeps } from './context.js';
import { requestStop } from './scheduler.js';

/** Backstop for an EC2 VM that became visible after its creating operation was interrupted. */
export async function enforceStoppedIntent(deps: EngineDeps): Promise<number> {
  const { db } = deps;
  const halted = await db.select().from(schema.browserInstances).where(and(
    eq(schema.browserInstances.desiredState, 'stopped'), notInArray(schema.browserInstances.status, ['deleting', 'purged', 'failed']),
  ));
  if (!halted.length) return 0;
  const byId = new Map(halted.map((i) => [i.id, i]));
  const busy = new Set((await db.select({ id: schema.operations.instanceId }).from(schema.operations).where(isNull(schema.operations.finishedAt))).map((r) => r.id));
  const configured = await db.select().from(schema.regions).where(inArray(schema.regions.id, [...new Set(halted.map((i) => i.regionId))]));
  const places = await db.select().from(schema.placements).where(inArray(schema.placements.instanceId, [...byId.keys()]));
  const targets = new Map<string, { executor: ExecutorKind; region: string }>();
  for (const r of configured) targets.set(`${r.executor}:${r.providerRegion}`, { executor: r.executor as ExecutorKind, region: r.providerRegion });
  for (const p of places) targets.set(`${p.executor}:${p.providerRegion}`, { executor: p.executor as ExecutorKind, region: p.providerRegion });
  let queued = 0;
  for (const target of targets.values()) {
    const all = await deps.executor(target.executor).listManaged(readContext('stopped-intent-inventory', deps.envName), target.region);
    for (const vm of all) {
      if (vm.kind !== 'vm' || !['pending', 'running'].includes(vm.state) || vm.tags['cb:env'] !== deps.envName) continue;
      const inst = byId.get(vm.tags['cb:instance'] ?? '');
      if (!inst || busy.has(inst.id)) continue;
      // The atomic request and unique operation index arbitrate a simultaneous wake/delete.
      // Never send a raw StopInstances request from a potentially stale inventory snapshot.
      if (await requestStop(deps, inst, 'intent_reconcile')) { busy.add(inst.id); queued++; }
    }
  }
  return queued;
}
