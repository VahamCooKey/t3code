import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { SessionGroupsSnapshot, SessionGroupsUpdate } from "./sessionGroups.ts";

const decodeSnapshot = Schema.decodeUnknownSync(SessionGroupsSnapshot);
const decodeUpdate = Schema.decodeUnknownSync(SessionGroupsUpdate);

describe("session group contracts", () => {
  it("allows unlimited ordered groups and membership in multiple groups", () => {
    const groups = Array.from({ length: 200 }, (_, index) => ({
      id: `group-${index}`,
      name: `Group ${index}`,
      threadIds: ["thread-a"],
    }));
    expect(decodeSnapshot({ groups })).toEqual({ groups });
  });

  it("rejects duplicate group ids and duplicate membership in persisted snapshots", () => {
    const group = { id: "a", name: "A", threadIds: ["thread-a"] };
    expect(() => decodeSnapshot({ groups: [group, group] })).toThrow();
    expect(() =>
      decodeSnapshot({ groups: [{ ...group, threadIds: ["thread-a", "thread-a"] }] }),
    ).toThrow();
  });

  it("normalizes names and rejects blank names and invalid membership commands", () => {
    expect(decodeUpdate({ type: "create", id: "a", name: "  Work  " })).toEqual({
      type: "create",
      id: "a",
      name: "Work",
    });
    expect(() => decodeUpdate({ type: "rename", id: "a", name: "   " })).toThrow();
    expect(() =>
      decodeUpdate({ type: "membership", id: "a", threadId: "thread-a", member: "true" }),
    ).toThrow();
    expect(() =>
      decodeUpdate({ type: "membership", id: "a", threadId: "", member: true }),
    ).toThrow();
    expect(() => decodeUpdate({ type: "unknown", id: "a" })).toThrow();
  });

  it("accepts stale orders and explicit membership removal", () => {
    expect(decodeUpdate({ type: "reorder", ids: ["b", "a"] })).toEqual({
      type: "reorder",
      ids: ["b", "a"],
    });
    expect(
      decodeUpdate({ type: "membership", id: "a", threadId: "thread-a", member: false }).type,
    ).toBe("membership");
  });
});
