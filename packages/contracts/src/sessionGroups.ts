import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SessionGroupId = TrimmedNonEmptyString;
export type SessionGroupId = typeof SessionGroupId.Type;

export const SessionGroup = Schema.Struct({
  id: SessionGroupId,
  name: TrimmedNonEmptyString,
  threadIds: Schema.Array(ThreadId).check(
    Schema.makeFilter((ids) => new Set(ids).size === ids.length, {
      expected: "unique thread ids",
    }),
  ),
});
export type SessionGroup = typeof SessionGroup.Type;

export const SessionGroupsSnapshot = Schema.Struct({
  groups: Schema.Array(SessionGroup).check(
    Schema.makeFilter((groups) => new Set(groups.map((group) => group.id)).size === groups.length, {
      expected: "unique session group ids",
    }),
  ),
});
export type SessionGroupsSnapshot = typeof SessionGroupsSnapshot.Type;

export const SessionGroupsUpdate = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("create"),
    id: SessionGroupId,
    name: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("rename"),
    id: SessionGroupId,
    name: TrimmedNonEmptyString,
  }),
  Schema.Struct({ type: Schema.Literal("delete"), id: SessionGroupId }),
  Schema.Struct({ type: Schema.Literal("reorder"), ids: Schema.Array(SessionGroupId) }),
  Schema.Struct({
    type: Schema.Literal("membership"),
    id: SessionGroupId,
    threadId: ThreadId,
    member: Schema.Boolean,
  }),
]);
export type SessionGroupsUpdate = typeof SessionGroupsUpdate.Type;

export class SessionGroupsError extends Schema.TaggedError<SessionGroupsError>()(
  "SessionGroupsError",
  {
    reason: Schema.Literals([
      "read",
      "corrupt",
      "write",
      "invalid-input",
      "not-found",
      "thread-not-found",
      "thread-read",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "read":
        return "Failed to read session groups.";
      case "corrupt":
        return "The session groups file is invalid. Repair it before changing groups.";
      case "write":
        return "Failed to save session groups.";
      case "invalid-input":
        return "Invalid session group update.";
      case "not-found":
        return "The session group no longer exists.";
      case "thread-not-found":
        return "The thread no longer exists.";
      case "thread-read":
        return "Failed to read the thread for session group membership.";
    }
  }
}
