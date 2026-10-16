import type { MenuAction } from "@react-native-menu/menu";
import type { SessionGroup, ThreadId } from "@t3tools/contracts";

export function sessionGroupMembershipMenu(
  groups: readonly SessionGroup[],
  threadId: ThreadId,
): MenuAction[] {
  if (groups.length === 0) return [];
  return [
    {
      id: "session-groups",
      title: "Session groups",
      image: "folder",
      subactions: groups.map((group) => ({
        id: `session-group:${group.id}`,
        title: group.name,
        state: group.threadIds.includes(threadId) ? "on" : "off",
      })),
    },
  ];
}

export function sessionGroupMembershipSelection(
  groups: readonly SessionGroup[],
  threadId: ThreadId,
  event: string,
) {
  const group = groups.find((item) => event === `session-group:${item.id}`);
  return group ? { id: group.id, threadId, member: !group.threadIds.includes(threadId) } : null;
}
