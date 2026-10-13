import type { EnvironmentId, SessionGroup, SessionGroupId, ThreadId } from "@t3tools/contracts";
import { filterSessionGroupThreads } from "@t3tools/client-runtime/state/sessionGroupLogic";

export interface SessionGroupSelection {
  readonly environmentId: EnvironmentId;
  readonly id: SessionGroupId;
}

/** Scope membership ids to their owning environment before applying the shared filter. */
export function filterSelectedSessionGroupThreads<
  T extends { readonly environmentId: EnvironmentId; readonly id: ThreadId },
>(
  threads: readonly T[],
  selection: SessionGroupSelection | null,
  group: SessionGroup | null,
): readonly T[] {
  if (selection === null) return threads;
  if (group === null) return [];
  return filterSessionGroupThreads(
    threads.filter((thread) => thread.environmentId === selection.environmentId),
    group,
  );
}

/** Only a loaded snapshot proves deletion; disconnecting must retain the filter. */
export function sessionGroupSelectionWasDeleted(
  selection: SessionGroupSelection | null,
  snapshots: ReadonlyMap<EnvironmentId, { readonly groups: readonly SessionGroup[] }>,
) {
  if (selection === null) return false;
  const snapshot = snapshots.get(selection.environmentId);
  return snapshot !== undefined && !snapshot.groups.some((group) => group.id === selection.id);
}
