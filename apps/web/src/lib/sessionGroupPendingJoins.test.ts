import type { EnvironmentId, SessionGroupId, ThreadId } from "@t3tools/contracts";
import type { DraftId } from "../composerDraftStore";
import { describe, expect, it } from "vite-plus/test";
import {
  resolveSessionGroupPendingJoins,
  SESSION_GROUP_PENDING_JOIN_TTL_MS,
  type SessionGroupPendingJoin,
} from "./sessionGroupPendingJoins";

const env = "local" as EnvironmentId;
const join = (draft: string, thread: string, createdAt = "2026-10-28T00:00:00Z") =>
  ({
    draftId: draft as DraftId,
    environmentId: env,
    threadId: thread as ThreadId,
    groupId: "fnf" as SessionGroupId,
    createdAt,
  }) satisfies SessionGroupPendingJoin;
const nowMs = Date.parse("2026-10-28T01:00:00Z");

describe("resolveSessionGroupPendingJoins", () => {
  it("joins once the draft's thread exists, following a changed draft id", () => {
    const result = resolveSessionGroupPendingJoins({
      joins: [join("d1", "t1"), join("d2", "t2")],
      draftThreadIds: new Map([["d2" as DraftId, "t2b" as ThreadId]]),
      liveThreadKeys: new Set(["local:t1"]),
      nowMs,
    });
    expect(result.ready.map((entry) => entry.threadId)).toEqual(["t1"]);
    expect(result.retargets).toEqual([{ draftId: "d2", threadId: "t2b" }]);
    expect(result.expired).toEqual([]);
  });

  it("uses the draft's current id when it already exists and expires stale drafts", () => {
    const old = new Date(nowMs - SESSION_GROUP_PENDING_JOIN_TTL_MS - 1).toISOString();
    const result = resolveSessionGroupPendingJoins({
      joins: [join("d1", "t1"), join("d3", "t3", old)],
      draftThreadIds: new Map([["d1" as DraftId, "t1b" as ThreadId]]),
      liveThreadKeys: new Set(["local:t1b"]),
      nowMs,
    });
    expect(result.ready.map((entry) => entry.threadId)).toEqual(["t1b"]);
    expect(result.expired).toEqual(["d3"]);
  });
});
