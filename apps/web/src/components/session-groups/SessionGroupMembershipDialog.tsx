import { create } from "zustand";
import { useId, useState } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { sessionGroupContainsThread } from "@t3tools/client-runtime/state/sessionGroupLogic";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useSessionGroups } from "../../hooks/useSessionGroups";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";

const useMembershipRequest = create<{ threadRef: ScopedThreadRef | null }>(() => ({
  threadRef: null,
}));

/** The sidebar hosts this once; both row and chat menus can open it. */
export function openSessionGroupMembership(threadRef: ScopedThreadRef) {
  useMembershipRequest.setState({ threadRef });
}

export function SessionGroupMembershipDialogHost() {
  const threadRef = useMembershipRequest((state) => state.threadRef);
  return threadRef ? (
    <SessionGroupMembershipDialog key={JSON.stringify(threadRef)} threadRef={threadRef} />
  ) : null;
}

function SessionGroupMembershipDialog({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const state = useSessionGroups([]);
  const environment = state.environments.find(
    (entry) => entry.environmentId === threadRef.environmentId,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const close = () => useMembershipRequest.setState({ threadRef: null });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Session groups</DialogTitle>
          <DialogDescription>
            Add this session to any number of groups, or remove its memberships.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {error ? (
            <p role="alert" className="mb-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {environment?.loaded ? (
            <div className="flex flex-col gap-3">
              {environment.groups.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Create a group using Groups in the sidebar.
                </p>
              ) : null}
              {environment.groups.map((group, index) => (
                <label
                  key={group.id}
                  htmlFor={id + "-" + index}
                  className="flex items-center gap-2 text-sm"
                >
                  <input
                    id={id + "-" + index}
                    type="checkbox"
                    checked={sessionGroupContainsThread(group, threadRef.threadId)}
                    disabled={busy || !environment.canOperate}
                    onChange={(event) => {
                      const member = event.target.checked;
                      setBusy(true);
                      setError(null);
                      void state
                        .update({
                          environmentId: threadRef.environmentId,
                          input: {
                            type: "membership",
                            id: group.id,
                            threadId: threadRef.threadId,
                            member,
                          },
                        })
                        .then((result) => {
                          if (result._tag === "Failure") {
                            const cause = squashAtomCommandFailure(result);
                            setError(
                              cause instanceof Error
                                ? cause.message
                                : "Could not change membership.",
                            );
                          }
                        })
                        .finally(() => setBusy(false));
                    }}
                  />
                  <span>{group.name}</span>
                </label>
              ))}
            </div>
          ) : (
            <p role="status" className="text-sm">
              {environment
                ? environment.canRead
                  ? "Loading groups…"
                  : "This connection cannot read session groups."
                : "Connect to this session's environment to edit groups."}
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
