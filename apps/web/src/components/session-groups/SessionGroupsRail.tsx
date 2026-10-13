import { useId, useState } from "react";
import type { EnvironmentId, SessionGroup, SessionGroupsUpdate } from "@t3tools/contracts";
import { sessionGroupAbbreviation } from "@t3tools/client-runtime/state/sessionGroupLogic";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { useSessionGroups } from "../../hooks/useSessionGroups";
import type { SessionGroupSelection } from "../../lib/sessionGroupSelection";
import { useEnvironments } from "../../state/environments";
import { Button } from "../ui/button";
import { randomUUID } from "../../lib/utils";
import { Tooltip, TooltipProvider, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";

type GroupsState = ReturnType<typeof useSessionGroups>;

export function SessionGroupsRail({
  state,
  onSelect = state.setSelection,
}: {
  readonly state: GroupsState;
  readonly onSelect?: (selection: SessionGroupSelection | null) => void;
}) {
  const [managing, setManaging] = useState(false);
  const { environments } = useEnvironments();
  const label = (id: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === id)?.label ?? id;
  if (state.environments.length === 0 && state.selection === null) return null;
  return (
    <>
      <TooltipProvider>
        <nav
          aria-label="Session groups"
          className="flex w-18 shrink-0 flex-col gap-1 overflow-y-auto border-r border-sidebar-border p-1"
        >
          <button
            type="button"
            aria-pressed={state.selection === null}
            aria-label="Show sessions from all groups"
            className="shrink-0 rounded-md px-1 py-2 text-xs hover:bg-sidebar-row-hover aria-pressed:bg-sidebar-row-selected focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => onSelect(null)}
          >
            All
          </button>
          {state.entries.map(({ environmentId, group, counts }) => (
            <Tooltip key={JSON.stringify([environmentId, group.id])}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-pressed={
                      state.selection?.environmentId === environmentId &&
                      state.selection?.id === group.id
                    }
                    aria-label={
                      group.name +
                      ", " +
                      counts.active +
                      " active, " +
                      counts.waiting +
                      " waiting, " +
                      label(environmentId)
                    }
                    onClick={() => onSelect({ environmentId, id: group.id })}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setManaging(true);
                    }}
                    className="flex shrink-0 flex-col items-center gap-0.5 rounded-md px-1 py-2 text-sidebar-muted-foreground hover:bg-sidebar-row-hover aria-pressed:bg-sidebar-row-selected aria-pressed:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-ring"
                  />
                }
              >
                <span className="text-xs font-semibold">
                  {sessionGroupAbbreviation(group.name)}
                </span>
                <span className="w-full truncate text-center text-3xs">{group.name}</span>
                <span className="text-3xs" aria-hidden>
                  A{counts.active} W{counts.waiting}
                </span>
              </TooltipTrigger>
              <TooltipPopup side="right">
                {group.name} · {label(environmentId)}
                <br />
                {counts.active} active · {counts.waiting} waiting
              </TooltipPopup>
            </Tooltip>
          ))}
          <button
            type="button"
            onClick={() => setManaging(true)}
            aria-label="Create or manage session groups"
            className="shrink-0 rounded-md px-1 py-2 text-xs hover:bg-sidebar-row-hover focus-visible:outline-2 focus-visible:outline-ring"
          >
            +<span className="block text-3xs">Groups</span>
          </button>
        </nav>
      </TooltipProvider>
      {managing ? (
        <ManageSessionGroups state={state} label={label} close={() => setManaging(false)} />
      ) : null}
    </>
  );
}

function ManageSessionGroups({
  state,
  label,
  close,
}: {
  readonly state: GroupsState;
  readonly label: (id: EnvironmentId) => string;
  readonly close: () => void;
}) {
  const nameId = useId();
  const environmentIdInput = useId();
  const [environmentId, setEnvironmentId] = useState(
    state.environments.find((environment) => environment.canOperate)?.environmentId ??
      state.environments[0]?.environmentId ??
      null,
  );
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{
    environmentId: EnvironmentId;
    group: SessionGroup;
  } | null>(null);
  const run = async (target: EnvironmentId, input: SessionGroupsUpdate) => {
    setBusy(true);
    setError(null);
    try {
      const result = await state.update({ environmentId: target, input });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "Could not update session groups.");
        return false;
      }
      return true;
    } finally {
      setBusy(false);
    }
  };
  const canCreate = state.environments.some(
    (environment) =>
      environment.environmentId === environmentId && environment.canOperate && environment.loaded,
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {deleting ? "Delete " + deleting.group.name + "?" : "Session groups"}
          </DialogTitle>
          <DialogDescription>
            {deleting
              ? "Chats stay in their projects. Only this group is removed."
              : "Organize sessions across projects and providers. Sessions can belong to several groups."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {error ? (
            <p role="alert" className="mb-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {!deleting ? (
            <div className="flex flex-col gap-4">
              <form
                className="flex flex-col gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (environmentId !== null && name.trim() && canCreate)
                    void run(environmentId, {
                      type: "create",
                      id: randomUUID(),
                      name: name.trim(),
                    }).then((ok) => {
                      if (ok) setName("");
                    });
                }}
              >
                <Label htmlFor={environmentIdInput}>Environment</Label>
                <select
                  id={environmentIdInput}
                  value={environmentId ?? ""}
                  disabled={busy}
                  className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                  onChange={(event) =>
                    setEnvironmentId(
                      state.environments.find(
                        (environment) => environment.environmentId === event.target.value,
                      )?.environmentId ?? null,
                    )
                  }
                >
                  {state.environments.map((environment) => (
                    <option key={environment.environmentId} value={environment.environmentId}>
                      {label(environment.environmentId)}
                    </option>
                  ))}
                </select>
                <Label htmlFor={nameId}>New group name</Label>
                <Input
                  id={nameId}
                  value={name}
                  disabled={busy || !canCreate}
                  onChange={(event) => setName(event.target.value)}
                />
                <div>
                  <Button type="submit" disabled={busy || !canCreate || !name.trim()}>
                    Create group
                  </Button>
                </div>
              </form>
              {state.environments.map((environment) => (
                <section
                  key={environment.environmentId}
                  aria-label={label(environment.environmentId)}
                >
                  <p className="mb-2 text-xs text-muted-foreground">
                    {label(environment.environmentId)}
                  </p>
                  {!environment.loaded ? (
                    <p role="status" className="text-sm">
                      {environment.canRead
                        ? "Loading groups…"
                        : "This connection cannot read session groups."}
                    </p>
                  ) : null}
                  <div className="flex flex-col gap-3">
                    {environment.groups.map((group, index) => (
                      <GroupEditor
                        key={group.id}
                        group={group}
                        disabled={busy || !environment.canOperate}
                        onRename={(nextName) =>
                          run(environment.environmentId, {
                            type: "rename",
                            id: group.id,
                            name: nextName,
                          })
                        }
                        onDelete={() => {
                          setError(null);
                          setDeleting({ environmentId: environment.environmentId, group });
                        }}
                        canMoveUp={index > 0}
                        canMoveDown={index < environment.groups.length - 1}
                        onMove={(direction) => {
                          const ids = environment.groups.map((item) => item.id);
                          const other = index + direction;
                          [ids[index], ids[other]] = [ids[other]!, ids[index]!];
                          void run(environment.environmentId, { type: "reorder", ids });
                        }}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {deleting ? (
            <>
              <Button variant="outline" disabled={busy} onClick={() => setDeleting(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={
                  busy ||
                  !state.environments.some(
                    (environment) =>
                      environment.environmentId === deleting.environmentId &&
                      environment.canOperate,
                  )
                }
                onClick={() => {
                  void run(deleting.environmentId, { type: "delete", id: deleting.group.id }).then(
                    (ok) => {
                      if (ok) setDeleting(null);
                    },
                  );
                }}
              >
                Delete group
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={close}>
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function GroupEditor({
  group,
  disabled,
  onRename,
  onDelete,
  canMoveUp,
  canMoveDown,
  onMove,
}: {
  readonly group: SessionGroup;
  readonly disabled: boolean;
  readonly onRename: (name: string) => Promise<boolean>;
  readonly onDelete: () => void;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly onMove: (direction: -1 | 1) => void;
}) {
  const id = useId();
  const [draftName, setDraftName] = useState<string | null>(null);
  const name = draftName ?? group.name;
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim())
          void onRename(name.trim()).then((ok) => {
            if (ok) setDraftName(null);
          });
      }}
    >
      <Label htmlFor={id}>Group name</Label>
      <Input
        id={id}
        value={name}
        disabled={disabled}
        onChange={(event) => setDraftName(event.target.value)}
      />
      <div className="flex flex-wrap gap-1">
        <Button
          size="sm"
          type="submit"
          variant="outline"
          disabled={disabled || !name.trim() || name.trim() === group.name}
        >
          Rename
        </Button>
        <Button
          size="sm"
          type="button"
          variant="ghost"
          disabled={disabled || !canMoveUp}
          aria-label={"Move " + group.name + " up"}
          onClick={() => onMove(-1)}
        >
          ↑
        </Button>
        <Button
          size="sm"
          type="button"
          variant="ghost"
          disabled={disabled || !canMoveDown}
          aria-label={"Move " + group.name + " down"}
          onClick={() => onMove(1)}
        >
          ↓
        </Button>
        <Button size="sm" type="button" variant="ghost" disabled={disabled} onClick={onDelete}>
          Delete
        </Button>
      </div>
    </form>
  );
}
