import * as Effect from "effect/Effect";
import { useEffect, useSyncExternalStore } from "react";
import { runtime } from "../lib/runtime";
import { MobileSecureStorage } from "../persistence/mobile-secure-storage";
import {
  createSessionGroupSelectionStore,
  resolveSessionGroupSelection,
  type SessionGroupEnvironment,
} from "../features/threads/session-groups/selection";

// Kept separate from server group membership/order and from the preferences blob.
const SELECTION_KEY = "t3code.session-group-selection";
const selectionStore = createSessionGroupSelectionStore({
  load: () =>
    runtime.runPromise(
      MobileSecureStorage.pipe(Effect.flatMap((storage) => storage.getItem(SELECTION_KEY))),
    ),
  save: (selection) =>
    runtime.runPromise(
      MobileSecureStorage.pipe(
        Effect.flatMap((storage) => storage.setItem(SELECTION_KEY, JSON.stringify(selection))),
      ),
    ),
});

/** Header actions must clear selection even when their scope value is unchanged. */
export function clearSessionGroupSelection(): Promise<void> {
  return selectionStore.select(null);
}

export function useSessionGroupSelection(environments: readonly SessionGroupEnvironment[]) {
  const snapshot = useSyncExternalStore(selectionStore.subscribe, selectionStore.getSnapshot);
  const selection = resolveSessionGroupSelection(snapshot.selection, environments);
  useEffect(() => {
    void selectionStore.load();
  }, []);
  useEffect(() => {
    if (snapshot.selection !== null && selection === null) void selectionStore.select(null);
  }, [snapshot.selection, selection]);
  return { ...snapshot, selection, select: selectionStore.select };
}
