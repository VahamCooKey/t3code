import type { EnvironmentId, SessionGroupId, ThreadId } from "@t3tools/contracts";
import type { DraftId } from "../composerDraftStore";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { resolveStorage } from "./storage";

/** A chat started from a group. Membership needs a live thread, so the join
    waits until the draft's first message creates it. */
export interface SessionGroupPendingJoin {
  readonly draftId: DraftId;
  readonly environmentId: EnvironmentId;
  /** Last known id; a failed first send can give the draft a new one. */
  readonly threadId: ThreadId;
  readonly groupId: SessionGroupId;
  readonly createdAt: string;
}

/** Drafts left unsent this long stop joining their group. */
export const SESSION_GROUP_PENDING_JOIN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface PendingJoinState {
  readonly joins: readonly SessionGroupPendingJoin[];
  readonly add: (join: SessionGroupPendingJoin) => void;
  readonly remove: (draftId: DraftId) => void;
  readonly retarget: (draftId: DraftId, threadId: ThreadId) => void;
}

export const useSessionGroupPendingJoins = create<PendingJoinState>()(
  persist(
    (set) => ({
      joins: [],
      add: (join) =>
        set((state) => ({
          joins: [...state.joins.filter((entry) => entry.draftId !== join.draftId), join],
        })),
      remove: (draftId) =>
        set((state) => ({ joins: state.joins.filter((entry) => entry.draftId !== draftId) })),
      retarget: (draftId, threadId) =>
        set((state) => ({
          joins: state.joins.map((entry) =>
            entry.draftId === draftId && entry.threadId !== threadId
              ? { ...entry, threadId }
              : entry,
          ),
        })),
    }),
    {
      name: "t3code:session-group-pending-joins:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: ({ joins }) => ({ joins }),
    },
  ),
);

/** Which pending joins can be applied now, which ids changed, and which expired. */
export function resolveSessionGroupPendingJoins(input: {
  readonly joins: readonly SessionGroupPendingJoin[];
  /** Current thread id of each draft still in the draft store. */
  readonly draftThreadIds: ReadonlyMap<DraftId, ThreadId>;
  readonly liveThreadKeys: ReadonlySet<string>;
  readonly nowMs: number;
}) {
  const ready: SessionGroupPendingJoin[] = [];
  const retargets: { draftId: DraftId; threadId: ThreadId }[] = [];
  const expired: DraftId[] = [];
  for (const join of input.joins) {
    const threadId = input.draftThreadIds.get(join.draftId) ?? join.threadId;
    if (input.liveThreadKeys.has(`${join.environmentId}:${threadId}`)) {
      ready.push({ ...join, threadId });
    } else if (input.nowMs - Date.parse(join.createdAt) > SESSION_GROUP_PENDING_JOIN_TTL_MS) {
      expired.push(join.draftId);
    } else if (threadId !== join.threadId) {
      retargets.push({ draftId: join.draftId, threadId });
    }
  }
  return { ready, retargets, expired };
}
