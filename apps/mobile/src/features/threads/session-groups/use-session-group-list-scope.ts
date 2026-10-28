import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useRef } from "react";
import type { SessionGroupSelection } from "./selection";
import { resolveSessionGroupListScope, sessionGroupSelectionShouldClear } from "./list-scope";

/** Bind every header filter action here; observing changed values misses same-value choices. */
export function useSessionGroupScopeActions(props: {
  readonly clearSelection: () => Promise<void>;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
}) {
  const { clearSelection, onEnvironmentChange, onProjectChange } = props;
  const changeEnvironment = useCallback(
    (next: EnvironmentId | null) => {
      void clearSelection();
      onEnvironmentChange(next);
    },
    [clearSelection, onEnvironmentChange],
  );
  const changeProject = useCallback(
    (next: string | null) => {
      void clearSelection();
      onProjectChange(next);
    },
    [clearSelection, onProjectChange],
  );
  return { changeEnvironment, changeProject };
}

/** Observes changed scopes as a fallback; header actions must use the explicit adapter. */
export function useSessionGroupListScope(props: {
  readonly selection: SessionGroupSelection | null;
  readonly select: (selection: SessionGroupSelection | null) => Promise<void>;
  readonly environmentId: EnvironmentId | null;
  readonly projectKey: string | null;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
}) {
  const { selection, select, environmentId, projectKey, onEnvironmentChange, onProjectChange } =
    props;
  const previous = useRef({ selection, environmentId, projectKey });
  // oxlint-disable-next-line t3code/react-effect-budget -- scope changes also arrive from saved list options and other screens, which have no handler here.
  useEffect(() => {
    const current = { selection, environmentId, projectKey };
    const clear = sessionGroupSelectionShouldClear(previous.current, current);
    previous.current = current;
    if (clear) void select(null);
  }, [selection, select, environmentId, projectKey]);
  const selectGroup = useCallback(
    (next: SessionGroupSelection | null) => {
      onEnvironmentChange(null);
      onProjectChange(null);
      void select(next);
    },
    [select, onEnvironmentChange, onProjectChange],
  );
  const clearSelection = useCallback(() => select(null), [select]);
  const { changeEnvironment, changeProject } = useSessionGroupScopeActions({
    clearSelection,
    onEnvironmentChange,
    onProjectChange,
  });
  return {
    ...resolveSessionGroupListScope({ environmentId, projectKey }, selection),
    selectGroup,
    changeEnvironment,
    changeProject,
  };
}
