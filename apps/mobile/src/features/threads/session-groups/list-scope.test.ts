import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type SessionGroup,
  THREAD_JUMP_KEYBINDING_COMMANDS,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { makeThreadShellFixture } from "../../../test-fixtures";
import { threadJumpTarget } from "../../keyboard/threadKeyboardShortcuts";
import { buildThreadListV2Items, buildThreadListV2ListItems } from "../threadListV2";
import { filterThreadsBySessionGroup } from "./selection";
import {
  resolveSessionGroupListScope,
  sessionGroupEmptyState,
  sessionGroupListResetKey,
  sessionGroupPendingTasks,
  sessionGroupSelectionShouldClear,
} from "./list-scope";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const selection = { environmentId: local, groupId: "work" };
const savedScope = { environmentId: remote, projectKey: "old-project" };
const now = "2026-10-13T00:00:00Z";

describe("mobile group list composition", () => {
  it("overrides saved environment/project scopes before search, shelves, pagination and keyboard targets", () => {
    const activeA = makeThreadShellFixture({
      environmentId: local,
      id: ThreadId.make("a"),
      title: "Needle one",
      projectId: ProjectId.make("one"),
    });
    const activeB = makeThreadShellFixture({
      environmentId: local,
      id: ThreadId.make("b"),
      title: "Needle two",
      projectId: ProjectId.make("two"),
    });
    const settledA = makeThreadShellFixture({
      environmentId: local,
      id: ThreadId.make("c"),
      title: "Needle three",
      settledOverride: "settled",
      settledAt: now,
    });
    const settledB = makeThreadShellFixture({
      environmentId: local,
      id: ThreadId.make("d"),
      title: "Needle four",
      settledOverride: "settled",
      settledAt: now,
    });
    const snoozed = makeThreadShellFixture({
      environmentId: local,
      id: ThreadId.make("e"),
      title: "Needle five",
      snoozedUntil: "2026-10-14T00:00:00Z",
    });
    const outside = makeThreadShellFixture({
      environmentId: local,
      id: ThreadId.make("outside"),
      title: "Search matches outside group",
      settledOverride: "settled",
      settledAt: now,
    });
    const wrongEnvironment = { ...activeA, environmentId: remote };
    const threads = [activeA, activeB, settledA, settledB, snoozed, outside, wrongEnvironment];
    const group: SessionGroup = {
      id: "work",
      name: "Work",
      threadIds: [activeA.id, activeB.id, settledA.id, settledB.id, snoozed.id],
    };
    const filtered = filterThreadsBySessionGroup(threads, selection, [
      { environmentId: local, groups: [group] },
    ]);
    const scope = resolveSessionGroupListScope(savedScope, selection);
    const layout = buildThreadListV2Items({
      threads: filtered,
      environmentId: scope.environmentId,
      projectRefs: null,
      searchQuery: "",
      now,
      settledLimit: 1,
      settledShelfExpanded: true,
      snoozedShelfExpanded: true,
    });
    expect(scope).toEqual({ environmentId: local, projectKey: null });
    expect(layout.settledCount).toBe(2);
    expect(layout.hiddenSettledCount).toBe(1);
    expect(layout.snoozedCount).toBe(1);
    // Search ranks matches in one list, still only from the group's members.
    const searched = buildThreadListV2Items({
      threads: filtered,
      environmentId: scope.environmentId,
      projectRefs: null,
      searchQuery: "needle",
      matchedThreadKeys: new Set([`${local}:${outside.id}`]),
      now,
    });
    expect(new Set(searched.items.map((item) => item.thread.id))).toEqual(
      new Set([activeA.id, activeB.id, settledA.id, settledB.id, snoozed.id]),
    );
    expect(searched.items.some((item) => item.thread.environmentId === remote)).toBe(false);
    const rows = buildThreadListV2ListItems({
      items: layout.items,
      pendingTasks: [],
      settledCount: layout.settledCount,
      settledShelfExpanded: true,
      snoozedCount: layout.snoozedCount,
      snoozedShelfExpanded: true,
    });
    expect(threadJumpTarget(rows, THREAD_JUMP_KEYBINDING_COMMANDS[0]!)).toBe(activeA);
    expect(threadJumpTarget(rows, THREAD_JUMP_KEYBINDING_COMMANDS[1]!)).toBe(activeB);
    // Membership filtering never mutates the shells used by lifecycle/reorder planners.
    expect(threads).toHaveLength(7);
    expect(
      filterThreadsBySessionGroup(threads, null, [{ environmentId: local, groups: [group] }]),
    ).toBe(threads);
  });

  it("empty groups retain their identity and exclude pending unsent tasks", () => {
    const empty = { id: "empty", name: "Launch planning", threadIds: [] };
    const chosen = { environmentId: local, groupId: empty.id };
    const tasks = [{ title: "Unsent task" }];
    expect(
      filterThreadsBySessionGroup([makeThreadShellFixture()], chosen, [
        { environmentId: local, groups: [empty] },
      ]),
    ).toEqual([]);
    expect(sessionGroupPendingTasks(tasks, chosen)).toEqual([]);
    expect(sessionGroupPendingTasks(tasks, null)).toBe(tasks);
    expect(sessionGroupEmptyState(empty.name, "").title).toBe("No chats in Launch planning");
    expect(sessionGroupEmptyState(empty.name, "missing").title).toBe(
      "No results in Launch planning",
    );
  });

  it("resets settled pagination for group switches, environment switches and All", () => {
    const scope = { environmentId: local, projectKey: null };
    const work = sessionGroupListResetKey(scope, selection, "");
    expect(sessionGroupListResetKey(scope, { ...selection, groupId: "review" }, "")).not.toBe(work);
    expect(sessionGroupListResetKey(scope, { ...selection, environmentId: remote }, "")).not.toBe(
      work,
    );
    expect(sessionGroupListResetKey(scope, null, "")).not.toBe(work);
    expect(sessionGroupListResetKey(scope, { ...selection }, "  ")).toBe(work);
  });

  it("clears groups on scope changes without undoing a concurrent group selection", () => {
    const previous = { ...savedScope, selection };
    expect(
      sessionGroupSelectionShouldClear(previous, {
        environmentId: local,
        projectKey: "new-project",
        selection,
      }),
    ).toBe(true);
    expect(
      sessionGroupSelectionShouldClear(previous, {
        environmentId: null,
        projectKey: null,
        selection: { ...selection },
      }),
    ).toBe(false);
    expect(sessionGroupSelectionShouldClear({ ...savedScope, selection: null }, previous)).toBe(
      false,
    );
    expect(resolveSessionGroupListScope(savedScope, null)).toBe(savedScope);
  });
});
