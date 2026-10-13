import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type SessionGroup,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { makeThreadShellFixture } from "../../../test-fixtures";
import {
  createSessionGroupSelectionStore,
  decodeSessionGroupSelection,
  filterThreadsBySessionGroup,
  reorderedSessionGroupIds,
  resolveSessionGroupSelection,
  sessionGroupStatusCounts,
} from "./selection";
import { sessionGroupMembershipMenu, sessionGroupMembershipSelection } from "./membership-menu";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const first = ThreadId.make("first");
const second = ThreadId.make("second");
const groups: readonly SessionGroup[] = [
  { id: "work", name: "Work", threadIds: [first, second] },
  { id: "review", name: "Review", threadIds: [first] },
];
const environments = [
  { environmentId: local, groups },
  { environmentId: remote, groups },
];
const selection = { environmentId: local, groupId: "work" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("mobile group selection", () => {
  it("filters across projects/providers and excludes identical ids in another environment", () => {
    const threads = [
      makeThreadShellFixture({
        environmentId: local,
        id: second,
        projectId: ProjectId.make("b"),
        providerInstanceId: ProviderInstanceId.make("claude"),
      }),
      makeThreadShellFixture({ environmentId: remote, id: first }),
      makeThreadShellFixture({
        environmentId: local,
        id: first,
        projectId: ProjectId.make("a"),
        providerInstanceId: ProviderInstanceId.make("codex"),
      }),
      makeThreadShellFixture({ environmentId: local, id: ThreadId.make("other") }),
    ];
    expect(filterThreadsBySessionGroup(threads, selection, environments)).toEqual([
      threads[0],
      threads[2],
    ]);
    expect(
      filterThreadsBySessionGroup(
        threads,
        { environmentId: local, groupId: "review" },
        environments,
      ),
    ).toEqual([threads[2]]);
    expect(filterThreadsBySessionGroup(threads, null, environments)).toBe(threads);
  });

  it("keeps pending/offline selections without showing unrelated chats", () => {
    const threads = [{ environmentId: local, id: first }];
    const pending = [{ environmentId: local, groups: null }];
    expect(resolveSessionGroupSelection(selection, pending)).toBe(selection);
    expect(resolveSessionGroupSelection(selection, [])).toBe(selection);
    expect(filterThreadsBySessionGroup(threads, selection, pending)).toEqual([]);
    expect(filterThreadsBySessionGroup(threads, selection, [])).toEqual([]);
  });

  it("returns to All after a confirmed deletion without changing the chats", () => {
    const threads = [{ environmentId: local, id: first }];
    const deleted = [{ environmentId: local, groups: [groups[1]!] }];
    expect(resolveSessionGroupSelection(selection, deleted)).toBeNull();
    expect(filterThreadsBySessionGroup(threads, selection, deleted)).toBe(threads);
    expect(threads).toEqual([{ environmentId: local, id: first }]);
  });

  it("keeps the selection when a group is renamed/reordered", () => {
    expect(
      resolveSessionGroupSelection(selection, [
        { environmentId: local, groups: [groups[1]!, { ...groups[0]!, name: "Renamed" }] },
      ]),
    ).toBe(selection);
  });

  it("validates device storage and ignores malformed payloads", () => {
    expect(decodeSessionGroupSelection(JSON.stringify(selection))).toEqual(selection);
    expect(decodeSessionGroupSelection("null")).toBeNull();
    expect(decodeSessionGroupSelection("{")).toBeNull();
    expect(decodeSessionGroupSelection({ environmentId: "", groupId: "work" })).toBeNull();
    expect(decodeSessionGroupSelection({ environmentId: "local", groupId: [] })).toBeNull();
  });

  it("restores the same filter on a new client store", async () => {
    let saved: unknown = null;
    const storage = {
      load: async () => saved,
      save: async (value: unknown) => {
        saved = JSON.stringify(value);
      },
    };
    const original = createSessionGroupSelectionStore(storage);
    await original.load();
    await original.select(selection);
    const reopened = createSessionGroupSelectionStore(storage);
    await reopened.load();
    expect(reopened.getSnapshot().selection).toEqual(selection);
    await reopened.select(null);
    const afterAll = createSessionGroupSelectionStore(storage);
    await afterAll.load();
    expect(afterAll.getSnapshot().selection).toBeNull();
  });

  it("never lets a delayed restore overwrite a new selection or All", async () => {
    const read = deferred<unknown>();
    const store = createSessionGroupSelectionStore({
      load: () => read.promise,
      save: async () => {},
    });
    const loading = store.load();
    await store.select(null);
    read.resolve(JSON.stringify(selection));
    await loading;
    expect(store.getSnapshot()).toEqual({ selection: null, loaded: true, error: null });
  });

  it("serializes rapid changes so the last filter persists", async () => {
    const firstWrite = deferred<void>();
    const saved: unknown[] = [];
    const save = vi.fn(async (value: unknown) => {
      saved.push(value);
      if (saved.length === 1) await firstWrite.promise;
    });
    const store = createSessionGroupSelectionStore({ load: async () => null, save });
    const selecting = store.select(selection);
    const clearing = store.select(null);
    await Promise.resolve();
    expect(saved).toEqual([selection]);
    firstWrite.resolve();
    await Promise.all([selecting, clearing]);
    expect(saved).toEqual([selection, null]);
    expect(store.getSnapshot().selection).toBeNull();
  });

  it("reports persistence failure and continues saving later selections", async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk unavailable"))
      .mockResolvedValue(undefined);
    const store = createSessionGroupSelectionStore({ load: async () => null, save });
    await store.select(selection);
    expect(store.getSnapshot().selection).toEqual(selection);
    expect(store.getSnapshot().error).toContain("Could not save");
    await store.select(null);
    expect(store.getSnapshot().error).toBeNull();
    expect(save).toHaveBeenLastCalledWith(null);
  });

  it("shares selection with remounted observers", async () => {
    const store = createSessionGroupSelectionStore({
      load: async () => null,
      save: async () => {},
    });
    const firstObserver = vi.fn();
    const unsubscribe = store.subscribe(firstObserver);
    await store.select(selection);
    unsubscribe();
    const secondObserver = vi.fn();
    store.subscribe(secondObserver);
    expect(store.getSnapshot().selection).toEqual(selection);
    await store.select(null);
    expect(firstObserver).toHaveBeenCalledTimes(1);
    expect(secondObserver).toHaveBeenCalledTimes(1);
  });
});

describe("mobile group controls", () => {
  it("supports unlimited reorder entries without changing membership", () => {
    const many = Array.from({ length: 120 }, (_, index) => ({
      id: `g${index}`,
      name: `Group ${index}`,
      threadIds: [first],
    }));
    const reordered = reorderedSessionGroupIds(many, "g119", "up")!;
    expect(reordered).toHaveLength(120);
    expect(reordered.slice(-2)).toEqual(["g119", "g118"]);
    expect(many[119]!.id).toBe("g119");
    expect(reorderedSessionGroupIds(many, "g0", "up")).toBeNull();
    expect(reorderedSessionGroupIds(many, "missing", "down")).toBeNull();
  });

  it("adds/removes one membership while preserving memberships in other groups", () => {
    const menu = sessionGroupMembershipMenu(groups, first);
    expect(menu[0]!.subactions?.map((item) => item.state)).toEqual(["on", "on"]);
    expect(sessionGroupMembershipSelection(groups, first, "session-group:review")).toEqual({
      id: "review",
      threadId: first,
      member: false,
    });
    expect(sessionGroupMembershipSelection(groups, second, "session-group:review")).toEqual({
      id: "review",
      threadId: second,
      member: true,
    });
    expect(sessionGroupMembershipSelection(groups, first, "delete")).toBeNull();
    expect(groups[0]!.threadIds).toEqual([first, second]);
  });

  it("derives active/waiting counts from the same shell states as web", () => {
    const runtime = {
      status: "running" as const,
      providerName: "Codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: "full-access" as const,
      activeRunId: null,
      lastError: null,
      updatedAt: "2026-10-13T00:00:00Z",
    };
    const threads = [
      makeThreadShellFixture({ environmentId: local, id: first, runtime }),
      makeThreadShellFixture({
        environmentId: local,
        id: second,
        runtime: { ...runtime, status: "waiting" },
      }),
      makeThreadShellFixture({ environmentId: remote, id: first, hasPendingApprovals: true }),
    ];
    expect(sessionGroupStatusCounts(groups, local, threads).get("work")).toMatchObject({
      active: 1,
      waiting: 1,
    });
    expect(
      sessionGroupStatusCounts(groups, local, [
        { ...threads[0]!, hasPendingApprovals: true },
        { ...threads[1]!, hasPendingUserInput: true },
      ]).get("work"),
    ).toMatchObject({ active: 0, waiting: 2 });
    expect(
      sessionGroupStatusCounts(groups, local, [{ ...threads[0]!, archivedAt: "2026-10-13" }]).get(
        "work",
      ),
    ).toMatchObject({ active: 0, waiting: 0 });
    expect(
      sessionGroupStatusCounts(groups, local, [
        { ...threads[0]!, runtime: { ...runtime, status: "idle" } },
      ]).get("work"),
    ).toMatchObject({ active: 0, waiting: 0 });
  });
});
