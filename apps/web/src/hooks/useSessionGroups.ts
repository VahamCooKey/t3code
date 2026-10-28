import { useAtomValue } from "@effect/atom-react";
import { createSessionGroupsAtoms } from "@t3tools/client-runtime/state/sessionGroups";
import {
  deriveSessionGroupCounts,
  sessionGroupThreadIsUnseen,
} from "@t3tools/client-runtime/state/sessionGroupLogic";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  AuthOrchestrationReadScope,
  sessionGrantsScope,
  EnvironmentId,
  SessionGroupId,
  type SessionGroupsSnapshot,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSummaries } from "../state/presentation";
import { environmentSession } from "../state/session";
import { environmentServerConfigsAtom } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { useLocalStorage } from "./useLocalStorage";
import { useUiStateStore } from "../uiStateStore";
import { resolveThreadLastVisitedAt } from "../components/Sidebar.logic";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  sessionGroupSelectionWasDeleted,
  type SessionGroupSelection,
} from "../lib/sessionGroupSelection";

export const sessionGroupsEnvironment = createSessionGroupsAtoms(connectionAtomRuntime);
const selectionSchema = Schema.NullOr(
  Schema.Struct({ environmentId: EnvironmentId, id: SessionGroupId }),
);
const groupsStateAtom = Atom.make((get) => {
  const connected = get(environmentSummaries.connectedEnvironmentIdsAtom);
  const configs = get(environmentServerConfigsAtom);
  const snapshots = new Map<EnvironmentId, SessionGroupsSnapshot>();
  const environments = connected
    .filter((id) => configs.get(id)?.environment.capabilities.sessionGroups === true)
    .map((environmentId) => {
      const sessionResult = get(environmentSession.sessionStateAtom(environmentId));
      const session = Option.getOrNull(AsyncResult.value(sessionResult));
      const canRead =
        sessionResult._tag !== "Failure" &&
        session !== null &&
        sessionGrantsScope(session, AuthOrchestrationReadScope);
      const result = canRead
        ? get(sessionGroupsEnvironment.sessionGroupsAtom(environmentId))
        : null;
      const snapshot = result === null ? null : Option.getOrNull(AsyncResult.value(result));
      // Failed/stale subscriptions do not prove that a saved selection was deleted.
      if (result?._tag === "Success" && snapshot !== null) snapshots.set(environmentId, snapshot);
      return {
        environmentId,
        groups: snapshot?.groups ?? [],
        canRead,
        loaded: result?._tag === "Success",
        canOperate:
          canRead &&
          get(sessionGroupsEnvironment.updateSessionGroups.permissionAtom(environmentId)),
      };
    });
  return { environments, snapshots };
});

export function useSessionGroups(threads: readonly EnvironmentThreadShell[]) {
  const state = useAtomValue(groupsStateAtom);
  const localLastVisitedAtById = useUiStateStore((store) => store.threadLastVisitedAtById);
  const [selection, setSelection] = useLocalStorage(
    "t3code:session-group-selection",
    null as SessionGroupSelection | null,
    selectionSchema,
  );
  // oxlint-disable-next-line t3code/react-effect-budget -- a group deleted on another client arrives through the subscription, so no local handler can clear the stored selection.
  useEffect(() => {
    if (sessionGroupSelectionWasDeleted(selection, state.snapshots)) setSelection(null);
  }, [selection, setSelection, state.snapshots]);
  const entries = state.environments.flatMap((environment) => {
    const shells = threads.filter(
      (thread) => thread.environmentId === environment.environmentId && thread.archivedAt === null,
    );
    const counts = deriveSessionGroupCounts(
      environment.groups,
      shells.map((thread) => ({
        id: thread.id,
        status:
          thread.hasPendingApprovals || thread.hasPendingUserInput
            ? "waiting"
            : (thread.runtime?.status ?? "stopped"),
        unseen: sessionGroupThreadIsUnseen({
          latestRun: thread.latestRun,
          lastVisitedAt: resolveThreadLastVisitedAt(
            thread.lastVisitedAt,
            localLastVisitedAtById[
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
            ],
          ),
        }),
      })),
    );
    return environment.groups.map((group) => ({
      ...environment,
      group,
      counts: counts.get(group.id)!,
    }));
  });
  const selectedGroup =
    selection === null
      ? null
      : (entries.find(
          (entry) =>
            entry.environmentId === selection.environmentId && entry.group.id === selection.id,
        )?.group ?? null);
  const runUpdate = useAtomCommand(sessionGroupsEnvironment.updateSessionGroups, {
    reportFailure: false,
  });
  const update = runUpdate;
  return { ...state, entries, selection, selectedGroup, setSelection, update };
}
