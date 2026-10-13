import type { EnvironmentId, SessionGroupId, ThreadId } from "@t3tools/contracts";
import type { SessionGroupEnvironment } from "./selection";

/** Bind these callbacks to the shared sessionGroups command in the destination environment. */
export interface MobileSessionGroupCommands {
  /** Read from sessionGroupsUpdate.permissionAtom for this destination. */
  readonly canUpdate: boolean;
  readonly create: (name: string) => Promise<void>;
  readonly rename: (id: SessionGroupId, name: string) => Promise<void>;
  readonly delete: (id: SessionGroupId) => Promise<void>;
  readonly reorder: (ids: readonly SessionGroupId[]) => Promise<void>;
  readonly membership: (id: SessionGroupId, threadId: ThreadId, member: boolean) => Promise<void>;
}

export interface MobileSessionGroupEnvironment extends SessionGroupEnvironment {
  readonly label: string;
  readonly error: string | null;
  readonly commands: MobileSessionGroupCommands;
}

export interface MobileSessionGroupEditor {
  readonly environmentId: EnvironmentId;
  readonly groupId: SessionGroupId | null;
}
