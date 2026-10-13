import type { EnvironmentId } from "@t3tools/contracts";
import type { SessionGroupSelection } from "./selection";

export interface SessionGroupListScope {
  readonly environmentId: EnvironmentId | null;
  readonly projectKey: string | null;
}

/** Saved groups take precedence over saved project/environment filters. */
export function resolveSessionGroupListScope(
  scope: SessionGroupListScope,
  selection: SessionGroupSelection | null,
): SessionGroupListScope {
  return selection === null ? scope : { environmentId: selection.environmentId, projectKey: null };
}

/** Concurrent scope clears caused by choosing a group must not cancel that choice. */
export function sessionGroupSelectionShouldClear(
  previous: SessionGroupListScope & { readonly selection: SessionGroupSelection | null },
  current: SessionGroupListScope & { readonly selection: SessionGroupSelection | null },
): boolean {
  return (
    current.selection !== null &&
    previous.selection === current.selection &&
    (previous.environmentId !== current.environmentId || previous.projectKey !== current.projectKey)
  );
}

export function sessionGroupListResetKey(
  scope: SessionGroupListScope,
  selection: SessionGroupSelection | null,
  searchQuery: string,
): string {
  return JSON.stringify([
    scope.environmentId,
    scope.projectKey,
    selection?.environmentId ?? null,
    selection?.groupId ?? null,
    searchQuery.trim(),
  ]);
}

/** Unsent tasks have no server membership yet. */
export function sessionGroupPendingTasks<T>(
  tasks: readonly T[],
  selection: SessionGroupSelection | null,
): readonly T[] {
  return selection === null ? tasks : [];
}

export function sessionGroupEmptyState(groupName: string, searchQuery: string) {
  return searchQuery.trim()
    ? {
        title: `No results in ${groupName}`,
        detail: `No chats in this group match "${searchQuery}". Choose All to search across groups.`,
      }
    : {
        title: `No chats in ${groupName}`,
        detail: "Add chats using the group menu, or choose All to show every chat.",
      };
}
