import {
  EnvironmentId,
  type SessionGroup,
  type SessionGroupId,
  type ThreadId,
} from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import {
  deriveSessionGroupCounts,
  sessionGroupThreadIsUnseen,
} from "@t3tools/client-runtime/state/sessionGroupLogic";

export { sessionGroupAbbreviation } from "@t3tools/client-runtime/state/sessionGroupLogic";

export interface SessionGroupSelection {
  readonly environmentId: EnvironmentId;

  readonly groupId: SessionGroupId;
}

export interface SessionGroupEnvironment {
  readonly environmentId: EnvironmentId;

  /** null means the snapshot has not arrived; an empty array is authoritative. */

  readonly groups: readonly SessionGroup[] | null;
}

export function decodeSessionGroupSelection(raw: unknown): SessionGroupSelection | null {
  try {
    const value: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;

    if (
      typeof value !== "object" ||
      value === null ||
      !("environmentId" in value) ||
      typeof value.environmentId !== "string" ||
      !value.environmentId.trim() ||
      !("groupId" in value) ||
      typeof value.groupId !== "string" ||
      !value.groupId.trim()
    )
      return null;

    return { environmentId: EnvironmentId.make(value.environmentId), groupId: value.groupId };
  } catch {
    return null;
  }
}

/** Preserve an offline/loading selection. Only a confirmed deletion resets it. */

export function resolveSessionGroupSelection(
  selection: SessionGroupSelection | null,

  environments: readonly SessionGroupEnvironment[],
): SessionGroupSelection | null {
  if (selection === null) return null;

  const environment = environments.find((item) => item.environmentId === selection.environmentId);

  if (!environment || environment.groups === null) return selection;

  return environment.groups.some((group) => group.id === selection.groupId) ? selection : null;
}

/** Apply before project grouping, shelves, search results, and keyboard targets. */

export function filterThreadsBySessionGroup<
  T extends { readonly environmentId: EnvironmentId; readonly id: ThreadId },
>(
  threads: readonly T[],

  selection: SessionGroupSelection | null,

  environments: readonly SessionGroupEnvironment[],
): readonly T[] {
  const resolved = resolveSessionGroupSelection(selection, environments);

  if (resolved === null) return threads;

  const group = environments
    .find((item) => item.environmentId === resolved.environmentId)

    ?.groups?.find((item) => item.id === resolved.groupId);

  if (!group) return [];

  const members = new Set(group.threadIds);

  return threads.filter(
    (thread) => thread.environmentId === resolved.environmentId && members.has(thread.id),
  );
}

export function reorderedSessionGroupIds(
  groups: readonly SessionGroup[],
  id: SessionGroupId,
  direction: "up" | "down",
): readonly SessionGroupId[] | null {
  const index = groups.findIndex((group) => group.id === id);

  const target = index + (direction === "up" ? -1 : 1);

  if (index < 0 || target < 0 || target >= groups.length) return null;

  const ids = groups.map((group) => group.id);

  [ids[index], ids[target]] = [ids[target]!, ids[index]!];

  return ids;
}

export function sessionGroupStatusCounts(
  groups: readonly SessionGroup[],
  environmentId: EnvironmentId,

  threads: readonly EnvironmentThreadShell[],
) {
  return deriveSessionGroupCounts(
    groups,
    threads
      .filter((thread) => thread.environmentId === environmentId && thread.archivedAt === null)
      .map((thread) => ({
        id: thread.id,

        status:
          thread.hasPendingApprovals || thread.hasPendingUserInput
            ? "waiting"
            : (thread.runtime?.status ?? "stopped"),
        unseen: sessionGroupThreadIsUnseen(thread),
      })),
  );
}

interface SelectionSnapshot {
  readonly selection: SessionGroupSelection | null;

  readonly loaded: boolean;

  readonly error: string | null;
}

/** One shared device selection survives compact/sidebar remounts and ordered writes. */

export function createSessionGroupSelectionStore(storage: {
  readonly load: () => Promise<unknown>;

  readonly save: (selection: SessionGroupSelection | null) => Promise<void>;
}) {
  let snapshot: SelectionSnapshot = { selection: null, loaded: false, error: null };

  const listeners = new Set<() => void>();

  let loading: Promise<void> | undefined;

  let writes = Promise.resolve();

  let revision = 0;

  const publish = (next: SelectionSnapshot) => {
    snapshot = next;

    for (const listener of listeners) listener();
  };

  return {
    getSnapshot: () => snapshot,

    subscribe: (listener: () => void) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },

    load: () => {
      if (loading) return loading;

      const startedAt = revision;

      loading = storage
        .load()
        .then((raw) => {
          if (revision === startedAt) {
            publish({ selection: decodeSessionGroupSelection(raw), loaded: true, error: null });
          }
        })
        .catch(() => {
          if (revision === startedAt) {
            publish({ ...snapshot, loaded: true, error: "Could not restore the selected group." });
          }
        });

      return loading;
    },

    select: (selection: SessionGroupSelection | null) => {
      const selectedAt = ++revision;

      publish({ selection, loaded: true, error: null });

      writes = writes
        .then(() => storage.save(selection))
        .catch(() => {
          if (revision === selectedAt) {
            publish({ ...snapshot, error: "Could not save the selected group on this device." });
          }
        });

      return writes;
    },
  };
}
