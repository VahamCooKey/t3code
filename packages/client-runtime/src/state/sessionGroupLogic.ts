import type { SessionGroup, SessionGroupId, ThreadId } from "@t3tools/contracts";

const ABBREVIATION_CHAR = /[\p{L}\p{N}]/u;

/** Rail badge for a group: up to three uppercase Unicode letters/numbers
    from the name, "GRP" when the name has none. Uppercasing before the scan
    keeps the result at three code points even for case-expanding letters. */
export function sessionGroupAbbreviation(name: string): string {
  const chars: string[] = [];
  for (const char of name.toUpperCase()) {
    if (ABBREVIATION_CHAR.test(char)) {
      chars.push(char);
      if (chars.length === 3) break;
    }
  }
  return chars.length > 0 ? chars.join("") : "GRP";
}

export function sessionGroupContainsThread(
  group: Pick<SessionGroup, "threadIds">,
  threadId: ThreadId,
): boolean {
  return group.threadIds.includes(threadId);
}

/** Threads visible under a group filter, in the caller's order. No filter
    (null/undefined) returns the input as-is. */
export function filterSessionGroupThreads<T extends { readonly id: ThreadId }>(
  threads: ReadonlyArray<T>,
  group: Pick<SessionGroup, "threadIds"> | null | undefined,
): ReadonlyArray<T> {
  if (group == null) return threads;
  const memberIds = new Set(group.threadIds);
  return threads.filter((thread) => memberIds.has(thread.id));
}

export interface SessionGroupCountSummary {
  readonly total: number;
  readonly active: number;
  readonly waiting: number;
}

/** Shell statuses that mean a thread is actively working. "waiting" is a
    state of its own, reported separately. */
const ACTIVE_THREAD_STATUSES = new Set(["preparing", "queued", "starting", "running"]);

/** Per-group membership, active, and waiting counts. Thread state is
    indexed once for all groups; stale ids (deleted threads) still count
    toward total as stored membership but never toward active/waiting. */
export function deriveSessionGroupCounts(
  groups: ReadonlyArray<SessionGroup>,
  threads: ReadonlyArray<{ readonly id: ThreadId; readonly status: string }>,
): ReadonlyMap<SessionGroupId, SessionGroupCountSummary> {
  const stateByThreadId = new Map<ThreadId, { active: boolean; waiting: boolean }>();
  for (const thread of threads) {
    stateByThreadId.set(thread.id, {
      active: ACTIVE_THREAD_STATUSES.has(thread.status),
      waiting: thread.status === "waiting",
    });
  }
  const counts = new Map<SessionGroupId, SessionGroupCountSummary>();
  for (const group of groups) {
    let total = 0;
    let active = 0;
    let waiting = 0;
    for (const threadId of group.threadIds) {
      total += 1;
      const state = stateByThreadId.get(threadId);
      if (state?.active) active += 1;
      if (state?.waiting) waiting += 1;
    }
    counts.set(group.id, { total, active, waiting });
  }
  return counts;
}
