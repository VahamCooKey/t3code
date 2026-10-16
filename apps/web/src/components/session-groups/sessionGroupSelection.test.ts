import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId, type SessionGroup } from "@t3tools/contracts";
import {
  filterSelectedSessionGroupThreads,
  sessionGroupSelectionWasDeleted,
} from "../../lib/sessionGroupSelection";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const id = ThreadId.make("shared-id");
const group: SessionGroup = { id: "work", name: "Work", threadIds: [id] };
const selection = { environmentId: remote, id: group.id };

describe("client-local session group selection", () => {
  it("keeps identical thread ids on other environments out of every filtered shelf and preserves row order", () => {
    const threads = [
      { environmentId: local, id },
      { environmentId: remote, id: ThreadId.make("other") },
      { environmentId: remote, id },
    ];
    expect(filterSelectedSessionGroupThreads(threads, selection, group)).toEqual([threads[2]]);
    expect(filterSelectedSessionGroupThreads(threads, null, null)).toBe(threads);
    expect(filterSelectedSessionGroupThreads(threads, selection, null)).toEqual([]);
  });
  it("clears a deleted group only after its own environment sends a snapshot", () => {
    expect(sessionGroupSelectionWasDeleted(selection, new Map())).toBe(false);
    expect(sessionGroupSelectionWasDeleted(selection, new Map([[local, { groups: [] }]]))).toBe(
      false,
    );
    expect(
      sessionGroupSelectionWasDeleted(selection, new Map([[remote, { groups: [group] }]])),
    ).toBe(false);
    expect(sessionGroupSelectionWasDeleted(selection, new Map([[remote, { groups: [] }]]))).toBe(
      true,
    );
    expect(sessionGroupSelectionWasDeleted(null, new Map([[remote, { groups: [] }]]))).toBe(false);
  });
});
