import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { Atom } from "effect/reactivity";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** Instantiate once with the surface's connection runtime. Mount
 * sessionGroupsAtom(environmentId) for every connected, capable environment.
 * It is an AsyncResult<SessionGroupsSnapshot>; watch sends the initial snapshot
 * and follows reconnects. Selection is deliberately owned by each client.
 * updateSessionGroups.run(registry, { environmentId, input: SessionGroupsUpdate })
 * uses the destination environment's standard orchestration-operate grant.
 */
export function createSessionGroupsAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const watch = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "session-groups:watch",
    tag: WS_METHODS.sessionGroupsWatch,
    idleTtlMs: 0,
  });
  const sessionGroupsAtom = Atom.family((environmentId: EnvironmentId) =>
    watch({ environmentId, input: {} }),
  );

  const updateSessionGroups = createEnvironmentRpcCommand(runtime, {
    label: "session-groups:update",
    tag: WS_METHODS.sessionGroupsUpdate,
    concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
  });
  return { sessionGroupsAtom, updateSessionGroups };
}
