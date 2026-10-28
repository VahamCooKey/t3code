import { create } from "zustand";
import { useId, useState } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  sessionGroupBadgeLabel,
  sessionGroupContainsThread,
} from "@t3tools/client-runtime/state/sessionGroupLogic";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useSessionGroups } from "../../hooks/useSessionGroups";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { randomUUID } from "../../lib/utils";
import { sessionGroupTint } from "./SessionGroupsRail";
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
  const newGroupId = useId();
  const [newGroupName, setNewGroupName] = useState("");
  const close = () => useMembershipRequest.setState({ threadRef: null });
  const reportFailure = (result: Awaited<ReturnType<typeof state.update>>, fallback: string) => {
    if (result._tag !== "Failure") return false;
    const cause = squashAtomCommandFailure(result);
    setError(cause instanceof Error ? cause.message : fallback);
    return true;
  };
  const createAndAdd = async () => {
    const name = newGroupName.trim();
    if (!name || !environment?.canOperate) return;
    const groupId = randomUUID();
    setBusy(true);
    setError(null);
    try {
      const created = await state.update({
        environmentId: threadRef.environmentId,
        input: { type: "create", id: groupId, name },
      });
      if (reportFailure(created, "Could not create the group.")) return;
      const added = await state.update({
        environmentId: threadRef.environmentId,
        input: { type: "membership", id: groupId, threadId: threadRef.threadId, member: true },
      });
      if (!reportFailure(added, "Created the group, but could not add this chat.")) {
        setNewGroupName("");
      }
    } finally {
      setBusy(false);
    }
  };
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
            Pick every group this chat belongs to. Changes save immediately.
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
                <p className="text-sm text-muted-foreground">No groups yet. Create one below.</p>
              ) : null}
              {environment.groups.map((group, index) => (
                <label
                  key={group.id}
                  htmlFor={id + "-" + index}
                  className="flex items-center gap-2.5 rounded-md px-1 py-1 text-sm hover:bg-accent/50"
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
                  <span
                    aria-hidden
                    style={sessionGroupTint(group.id, true)}
                    className="flex h-6 min-w-8 items-center justify-center rounded px-1 text-2xs font-semibold"
                  >
                    {sessionGroupBadgeLabel(group.name)}
                  </span>
                  <span className="truncate">{group.name}</span>
                </label>
              ))}
              {environment.canOperate ? (
                <form
                  className="mt-1 flex items-center gap-2 border-t border-border pt-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void createAndAdd();
                  }}
                >
                  <Input
                    id={newGroupId}
                    aria-label="New group name"
                    placeholder="New group, e.g. FNF"
                    maxLength={80}
                    value={newGroupName}
                    disabled={busy}
                    className="min-w-0 flex-1"
                    onChange={(event) => setNewGroupName(event.target.value)}
                  />
                  <Button type="submit" variant="outline" disabled={busy || !newGroupName.trim()}>
                    Create and add
                  </Button>
                </form>
              ) : null}
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
