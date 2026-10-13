import { describe, expect, it } from "vite-plus/test";

import type { SessionGroup, SessionGroupId, ThreadId } from "@t3tools/contracts";

import {
  deriveSessionGroupCounts,
  filterSessionGroupThreads,
  sessionGroupAbbreviation,
  sessionGroupContainsThread,
} from "./sessionGroupLogic.ts";

const asThreadId = (id: string) => id as ThreadId;
const asGroupId = (id: string) => id as SessionGroupId;

function makeGroup(id: string, name: string, threadIds: ReadonlyArray<string>): SessionGroup {
  return { id: asGroupId(id), name, threadIds: threadIds.map(asThreadId) };
}

function makeThread(id: string, status: string): { id: ThreadId; status: string } {
  return { id: asThreadId(id), status };
}

describe("sessionGroupAbbreviation", () => {
  it("takes up to three uppercase leading letters and numbers", () => {
    expect(sessionGroupAbbreviation("Reviews")).toBe("REV");
    expect(sessionGroupAbbreviation("api group")).toBe("API");
    expect(sessionGroupAbbreviation("42nd street")).toBe("42N");
    expect(sessionGroupAbbreviation("ab")).toBe("AB");
  });

  it("skips non-letter characters between letters", () => {
    expect(sessionGroupAbbreviation("!!! hot fixes")).toBe("HOT");
    expect(sessionGroupAbbreviation("  v2  migration")).toBe("V2M");
  });

  it("handles Unicode letters, numbers, and astral code points", () => {
    expect(sessionGroupAbbreviation("设计 review")).toBe("设计R");
    expect(sessionGroupAbbreviation("乳製品リスト")).toBe("乳製品");
    expect(sessionGroupAbbreviation("٣ dos")).toBe("٣DO");
    expect(sessionGroupAbbreviation("𝕏enon fan")).toBe("𝕏EN");
  });

  it("returns GRP for names without usable characters", () => {
    expect(sessionGroupAbbreviation("")).toBe("GRP");
    expect(sessionGroupAbbreviation("   ")).toBe("GRP");
    expect(sessionGroupAbbreviation("!!!---")).toBe("GRP");
    expect(sessionGroupAbbreviation("🎮🚀")).toBe("GRP");
  });
});

describe("sessionGroupContainsThread", () => {
  it("reports membership", () => {
    const group = makeGroup("g1", "Group", ["t1", "t2"]);
    expect(sessionGroupContainsThread(group, asThreadId("t1"))).toBe(true);
    expect(sessionGroupContainsThread(group, asThreadId("t3"))).toBe(false);
  });
});

describe("filterSessionGroupThreads", () => {
  const threads = [
    makeThread("t1", "idle"),
    makeThread("t2", "running"),
    makeThread("t3", "waiting"),
    makeThread("t4", "idle"),
  ];

  it("returns the input unchanged without a filter", () => {
    expect(filterSessionGroupThreads(threads, null)).toBe(threads);
    expect(filterSessionGroupThreads(threads, undefined)).toBe(threads);
  });

  it("keeps only members in original order, sharing element identity", () => {
    const group = makeGroup("g1", "Group", ["t3", "t1", "t9"]);
    const filtered = filterSessionGroupThreads(threads, group);
    expect(filtered).toEqual([threads[0], threads[2]]);
    expect(filtered[0]).toBe(threads[0]);
    expect(filtered[1]).toBe(threads[2]);
  });

  it("ignores stale membership ids and tolerates empty groups", () => {
    expect(filterSessionGroupThreads(threads, makeGroup("g1", "Group", ["t9"]))).toEqual([]);
    expect(filterSessionGroupThreads(threads, makeGroup("g1", "Group", []))).toEqual([]);
  });
});

describe("deriveSessionGroupCounts", () => {
  it("counts active and waiting separately from shell statuses", () => {
    const groups = [makeGroup("g1", "Work", ["running", "waiting", "idle", "completed"])];
    const threads = [
      makeThread("running", "running"),
      makeThread("waiting", "waiting"),
      makeThread("idle", "idle"),
      makeThread("completed", "completed"),
    ];
    expect(deriveSessionGroupCounts(groups, threads).get(asGroupId("g1"))).toEqual({
      total: 4,
      active: 1,
      waiting: 1,
    });
  });

  it("treats preparing, queued, starting, and running as active", () => {
    const groups = [
      makeGroup("g1", "Busy", ["t1", "t2", "t3", "t4", "t5"]),
    ];
    const threads = [
      makeThread("t1", "preparing"),
      makeThread("t2", "queued"),
      makeThread("t3", "starting"),
      makeThread("t4", "running"),
      makeThread("t5", "failed"),
    ];
    expect(deriveSessionGroupCounts(groups, threads).get(asGroupId("g1"))).toEqual({
      total: 5,
      active: 4,
      waiting: 0,
    });
  });

  it("counts a thread in each of its groups and ignores threads outside groups", () => {
    const groups = [
      makeGroup("g1", "A", ["shared", "only-a"]),
      makeGroup("g2", "B", ["shared"]),
    ];
    const threads = [
      makeThread("shared", "running"),
      makeThread("only-a", "waiting"),
      makeThread("ungrouped", "running"),
    ];
    const counts = deriveSessionGroupCounts(groups, threads);
    expect(counts.get(asGroupId("g1"))).toEqual({ total: 2, active: 1, waiting: 1 });
    expect(counts.get(asGroupId("g2"))).toEqual({ total: 1, active: 1, waiting: 0 });
  });

  it("counts stale membership toward total only", () => {
    const groups = [makeGroup("g1", "Stale", ["deleted", "alive"])];
    const threads = [makeThread("alive", "idle")];
    expect(deriveSessionGroupCounts(groups, threads).get(asGroupId("g1"))).toEqual({
      total: 2,
      active: 0,
      waiting: 0,
    });
  });

  it("handles many groups and empty groups in one shape", () => {
    const groups = Array.from({ length: 200 }, (_, i) => makeGroup(`g${i}`, `Group ${i}`, []));
    const counts = deriveSessionGroupCounts(groups, []);
    expect(counts.size).toBe(200);
    for (const group of groups) {
      expect(counts.get(group.id)).toEqual({ total: 0, active: 0, waiting: 0 });
    }
  });
});
