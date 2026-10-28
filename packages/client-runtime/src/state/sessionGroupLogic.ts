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

/** Rail label: names that are already short codes (FNF, PP) read as typed,
    several words use their initials, and other names their abbreviation. */
export function sessionGroupBadgeLabel(name: string): string {
  const trimmed = name.trim();
  if ([...trimmed].length <= 4 && !/\s/u.test(trimmed)) return trimmed.toUpperCase();
  const initials = trimmed
    .split(/\s+/u)
    .map((word) => sessionGroupAbbreviation(word))
    .filter((abbreviation) => abbreviation !== "GRP")
    .map((abbreviation) => [...abbreviation][0]!);
  return initials.length > 1 ? initials.slice(0, 3).join("") : sessionGroupAbbreviation(name);
}

/** Stable hue (0-359) from the group id, so a group keeps its color across
    renames, reorders and devices. */
export function sessionGroupHue(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 360;
}

/** A finished or failed run the user has not opened since. Threads never
    opened stay quiet unless they failed, matching the thread list. */
export function sessionGroupThreadIsUnseen(thread: {
  readonly latestRun: { readonly status: string; readonly completedAt?: string | null } | null;
  readonly lastVisitedAt?: string | null | undefined;
}): boolean {
  const run = thread.latestRun;
  if (run === null || !run.completedAt) return false;
  if (!thread.lastVisitedAt) return run.status === "failed";
  const completedAt = Date.parse(run.completedAt);
  const visitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(completedAt) || Number.isNaN(visitedAt)) return false;
  return completedAt > visitedAt;
}

export interface SessionGroupCountSummary {
  /** Stored membership, including ids of deleted or archived threads. */
  readonly total: number;
  /** Members that are still listed. */
  readonly live: number;
  readonly active: number;
  readonly waiting: number;
  /** Finished or failed since the user last opened them. */
  readonly unseen: number;
}

/** Shell statuses that mean a thread is actively working. "waiting" is a
    state of its own, reported separately. */
const ACTIVE_THREAD_STATUSES = new Set(["preparing", "queued", "starting", "running"]);

/** Per-group membership and status counts. Thread state is indexed once for
    all groups; stale ids (deleted threads) count toward total only. */
export function deriveSessionGroupCounts(
  groups: ReadonlyArray<SessionGroup>,
  threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly status: string;
    readonly unseen?: boolean;
  }>,
): ReadonlyMap<SessionGroupId, SessionGroupCountSummary> {
  const stateByThreadId = new Map<
    ThreadId,
    { active: boolean; waiting: boolean; unseen: boolean }
  >();
  for (const thread of threads) {
    const active = ACTIVE_THREAD_STATUSES.has(thread.status);
    const waiting = thread.status === "waiting";
    stateByThreadId.set(thread.id, {
      active,
      waiting,
      unseen: !active && !waiting && thread.unseen === true,
    });
  }
  const counts = new Map<SessionGroupId, SessionGroupCountSummary>();
  for (const group of groups) {
    let live = 0;
    let active = 0;
    let waiting = 0;
    let unseen = 0;
    for (const threadId of group.threadIds) {
      const state = stateByThreadId.get(threadId);
      if (state === undefined) continue;
      live += 1;
      if (state.active) active += 1;
      if (state.waiting) waiting += 1;
      if (state.unseen) unseen += 1;
    }
    counts.set(group.id, { total: group.threadIds.length, live, active, waiting, unseen });
  }
  return counts;
}
