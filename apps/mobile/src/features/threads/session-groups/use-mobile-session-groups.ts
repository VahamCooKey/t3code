import { useAtomValue } from "@effect/atom-react";
import { createSessionGroupsAtoms } from "@t3tools/client-runtime/state/sessionGroups";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationReadScope,
  sessionGrantsScope,
  type EnvironmentId,
  type SessionGroupsUpdate,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useMemo } from "react";
import { connectionAtomRuntime } from "../../../connection/runtime";
import { uuidv4 } from "../../../lib/uuid";
import { environmentServerConfigsAtom } from "../../../state/server";
import { environmentSession } from "../../../state/session";
import { useSessionGroupSelection } from "../../../state/session-group-selection";
import { useAtomCommand } from "../../../state/use-atom-command";
import { filterThreadsBySessionGroup } from "./selection";
import type { MobileSessionGroupCommands, MobileSessionGroupEnvironment } from "./types";

export const mobileSessionGroups = createSessionGroupsAtoms(connectionAtomRuntime);
const environmentGroupsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const capabilities = get(environmentServerConfigsAtom).get(environmentId)?.environment
      .capabilities;
    const supported =
      capabilities !== undefined &&
      "sessionGroups" in capabilities &&
      capabilities.sessionGroups === true;
    const sessionResult = get(environmentSession.sessionStateAtom(environmentId));
    const session = Option.getOrNull(AsyncResult.value(sessionResult));
    const canRead =
      sessionResult._tag !== "Failure" &&
      session !== null &&
      sessionGrantsScope(session, AuthOrchestrationReadScope);
    const result =
      supported && canRead ? get(mobileSessionGroups.sessionGroupsAtom(environmentId)) : null;
    // A failed or pending subscription cannot prove a saved group was deleted.
    const groups = result?._tag === "Success" ? result.value.groups : null;
    return {
      environmentId,
      supported,
      groups,
      error: !canRead
        ? "Group access unavailable"
        : result?._tag === "Failure"
          ? "Groups unavailable"
          : null,
      canUpdate:
        supported &&
        groups !== null &&
        get(mobileSessionGroups.updateSessionGroups.permissionAtom(environmentId)),
    };
  }),
);

function useUpdateSessionGroups() {
  const run = useAtomCommand(mobileSessionGroups.updateSessionGroups, { reportFailure: false });
  return useCallback(
    async (environmentId: EnvironmentId, input: SessionGroupsUpdate) => {
      const result = await run({ environmentId, input });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    },
    [run],
  );
}

function commandsFor(
  environmentId: EnvironmentId,
  canUpdate: boolean,
  update: ReturnType<typeof useUpdateSessionGroups>,
): MobileSessionGroupCommands {
  return {
    canUpdate,
    create: (name) => update(environmentId, { type: "create", id: uuidv4(), name }),
    rename: (id, name) => update(environmentId, { type: "rename", id, name }),
    delete: (id) => update(environmentId, { type: "delete", id }),
    reorder: (ids) => update(environmentId, { type: "reorder", ids }),
    membership: (id, threadId, member) =>
      update(environmentId, { type: "membership", id, threadId, member }),
  };
}

/** Row menus subscribe only to their own destination's groups. */
export function useMobileSessionGroupEnvironment(environmentId: EnvironmentId) {
  const state = useAtomValue(environmentGroupsAtom(environmentId));
  const update = useUpdateSessionGroups();
  const commands = useMemo(
    () => commandsFor(environmentId, state.canUpdate, update),
    [environmentId, state.canUpdate, update],
  );
  return { ...state, commands };
}

/** Shared by the compact Home root and the split-view navigation root. */
export function useMobileSessionGroups(
  availableEnvironments: readonly {
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }[],
  threads: readonly EnvironmentThreadShell[],
) {
  const stateAtom = useMemo(
    () =>
      Atom.make((get) =>
        availableEnvironments
          .map((environment) => ({
            ...get(environmentGroupsAtom(environment.environmentId)),
            label: environment.label,
          }))
          .filter((environment) => environment.supported),
      ),
    [availableEnvironments],
  );
  const state = useAtomValue(stateAtom);
  const update = useUpdateSessionGroups();
  const environments: readonly MobileSessionGroupEnvironment[] = useMemo(
    () =>
      state.map((environment) => ({
        ...environment,
        commands: commandsFor(environment.environmentId, environment.canUpdate, update),
      })),
    [state, update],
  );
  const selectionState = useSessionGroupSelection(environments);
  const filteredThreads = useMemo(
    () =>
      selectionState.loaded
        ? filterThreadsBySessionGroup(threads, selectionState.selection, environments)
        : [],
    [threads, selectionState.selection, selectionState.loaded, environments],
  );
  const selectedGroup =
    selectionState.selection === null
      ? null
      : (environments
          .find(
            (environment) => environment.environmentId === selectionState.selection?.environmentId,
          )
          ?.groups?.find((group) => group.id === selectionState.selection?.groupId) ?? null);
  return { ...selectionState, environments, filteredThreads, selectedGroup };
}
