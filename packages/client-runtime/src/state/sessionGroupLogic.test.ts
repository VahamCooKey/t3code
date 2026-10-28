import { describe, expect, it } from "vite-plus/test";

import type { SessionGroup, SessionGroupId, ThreadId } from "@t3tools/contracts";

import {
  deriveSessionGroupCounts,
  filterSessionGroupThreads,
  sessionGroupAbbreviation,
  sessionGroupBadgeLabel,
  sessionGroupContainsThread,
  sessionGroupHue,
  sessionGroupThreadIsUnseen,
  sessionGroupUsualProjectId,
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
      live: 4,
      active: 1,
      waiting: 1,
      unseen: 0,
    });
  });

  it("treats preparing, queued, starting, and running as active", () => {
    const groups = [makeGroup("g1", "Busy", ["t1", "t2", "t3", "t4", "t5"])];
    const threads = [
      makeThread("t1", "preparing"),
      makeThread("t2", "queued"),
      makeThread("t3", "starting"),
      makeThread("t4", "running"),
      makeThread("t5", "failed"),
    ];
    expect(deriveSessionGroupCounts(groups, threads).get(asGroupId("g1"))).toEqual({
      total: 5,
      live: 5,
      active: 4,
      waiting: 0,
      unseen: 0,
    });
  });

  it("counts a thread in each of its groups and ignores threads outside groups", () => {
    const groups = [makeGroup("g1", "A", ["shared", "only-a"]), makeGroup("g2", "B", ["shared"])];
    const threads = [
      makeThread("shared", "running"),
      makeThread("only-a", "waiting"),
      makeThread("ungrouped", "running"),
    ];
    const counts = deriveSessionGroupCounts(groups, threads);
    expect(counts.get(asGroupId("g1"))).toEqual({
      total: 2,
      live: 2,
      active: 1,
      waiting: 1,
      unseen: 0,
    });
    expect(counts.get(asGroupId("g2"))).toEqual({
      total: 1,
      live: 1,
      active: 1,
      waiting: 0,
      unseen: 0,
    });
  });

  it("counts stale membership toward total only", () => {
    const groups = [makeGroup("g1", "Stale", ["deleted", "alive"])];
    const threads = [makeThread("alive", "idle")];
    expect(deriveSessionGroupCounts(groups, threads).get(asGroupId("g1"))).toEqual({
      total: 2,
      live: 1,
      active: 0,
      waiting: 0,
      unseen: 0,
    });
  });

  it("counts unseen finished threads unless they are working or waiting", () => {
    const groups = [makeGroup("g1", "Review", ["done", "busy", "blocked", "seen"])];
    const threads = [
      { ...makeThread("done", "completed"), unseen: true },
      { ...makeThread("busy", "running"), unseen: true },
      { ...makeThread("blocked", "waiting"), unseen: true },
      makeThread("seen", "completed"),
    ];
    expect(deriveSessionGroupCounts(groups, threads).get(asGroupId("g1"))).toEqual({
      total: 4,
      live: 4,
      active: 1,
      waiting: 1,
      unseen: 1,
    });
  });

  it("handles many groups and empty groups in one shape", () => {
    const groups = Array.from({ length: 200 }, (_, i) => makeGroup(`g${i}`, `Group ${i}`, []));
    const counts = deriveSessionGroupCounts(groups, []);
    expect(counts.size).toBe(200);
    for (const group of groups) {
      expect(counts.get(group.id)).toEqual({ total: 0, live: 0, active: 0, waiting: 0, unseen: 0 });
    }
  });
});

describe("sessionGroupBadgeLabel", () => {
  it("keeps short codes and abbreviates longer names", () => {
    expect(sessionGroupBadgeLabel("fnf")).toBe("FNF");
    expect(sessionGroupBadgeLabel("PP")).toBe("PP");
    expect(sessionGroupBadgeLabel("Launch planning")).toBe("LP");
    expect(sessionGroupBadgeLabel("Marketing")).toBe("MAR");
    expect(sessionGroupBadgeLabel("Client - web build")).toBe("CWB");
    expect(sessionGroupBadgeLabel("A B")).toBe("AB");
  });
});

describe("sessionGroupHue", () => {
  it("is stable per id and within the color wheel", () => {
    expect(sessionGroupHue("work")).toBe(sessionGroupHue("work"));
    expect(sessionGroupHue("work")).not.toBe(sessionGroupHue("home"));
    for (const id of ["a", "b", "c", "a-very-long-group-id"]) {
      expect(sessionGroupHue(id)).toBeGreaterThanOrEqual(0);
      expect(sessionGroupHue(id)).toBeLessThan(360);
    }
  });
});

describe("sessionGroupThreadIsUnseen", () => {
  const run = (status: string, completedAt: string | null) => ({ status, completedAt });
  it("compares the latest finished run with the last visit", () => {
    expect(
      sessionGroupThreadIsUnseen({
        latestRun: run("completed", "2026-10-02T00:00:00Z"),
        lastVisitedAt: "2026-10-01T00:00:00Z",
      }),
    ).toBe(true);
    expect(
      sessionGroupThreadIsUnseen({
        latestRun: run("completed", "2026-10-01T00:00:00Z"),
        lastVisitedAt: "2026-10-02T00:00:00Z",
      }),
    ).toBe(false);
    expect(
      sessionGroupThreadIsUnseen({ latestRun: run("running", null), lastVisitedAt: null }),
    ).toBe(false);
  });
  it("flags never-opened failures but not never-opened completions", () => {
    expect(sessionGroupThreadIsUnseen({ latestRun: run("failed", "2026-10-01T00:00:00Z") })).toBe(
      true,
    );
    expect(
      sessionGroupThreadIsUnseen({ latestRun: run("completed", "2026-10-01T00:00:00Z") }),
    ).toBe(false);
  });
});

describe("sessionGroupUsualProjectId", () => {
  const shell = (
    id: string,
    projectId: string,
    updatedAt: string,
    archivedAt: string | null = null,
  ) => ({
    id: id as ThreadId,
    projectId,
    updatedAt,
    archivedAt,
  });
  it("picks the project most member chats live in", () => {
    const group = makeGroup("g", "FNF", ["a", "b", "c"]);
    expect(
      sessionGroupUsualProjectId(group, [
        shell("a", "web", "2026-10-01"),
        shell("b", "web", "2026-10-02"),
        shell("c", "api", "2026-10-09"),
        shell("outside", "api", "2026-10-10"),
      ]),
    ).toBe("web");
  });
  it("breaks ties by the most recently updated chat and ignores archived ones", () => {
    const group = makeGroup("g", "FNF", ["a", "b", "c"]);
    expect(
      sessionGroupUsualProjectId(group, [
        shell("a", "web", "2026-10-01"),
        shell("b", "api", "2026-10-05"),
        shell("c", "web", "2026-10-09", "2026-10-10"),
      ]),
    ).toBe("api");
    expect(sessionGroupUsualProjectId(makeGroup("g", "Empty", []), [])).toBeNull();
  });
});
