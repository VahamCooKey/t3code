import { useId, useState, type CSSProperties, type MouseEvent } from "react";
import type {
  EnvironmentId,
  ScopedThreadRef,
  SessionGroup,
  SessionGroupsUpdate,
} from "@t3tools/contracts";
import {
  sessionGroupBadgeLabel,
  sessionGroupContainsThread,
  sessionGroupHue,
  type SessionGroupCountSummary,
} from "@t3tools/client-runtime/state/sessionGroupLogic";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ArrowDownIcon, ArrowUpIcon, LayersIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type { useSessionGroups } from "../../hooks/useSessionGroups";
import type { SessionGroupSelection } from "../../lib/sessionGroupSelection";
import { readLocalApi } from "../../localApi";
import { useEnvironments } from "../../state/environments";
import { Button } from "../ui/button";
import { cn, randomUUID } from "../../lib/utils";
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
type GroupTarget = { readonly environmentId: EnvironmentId; readonly group: SessionGroup };
type RailDialog =
  | { readonly kind: "manage" }
  | { readonly kind: "create" }
  | { readonly kind: "rename"; readonly target: GroupTarget }
  | { readonly kind: "delete"; readonly target: GroupTarget };

/** Tile tint from the group's stable hue; reads on light and dark themes. */
export function sessionGroupTint(id: string, selected: boolean): CSSProperties {
  const hue = sessionGroupHue(id);
  return {
    backgroundColor: `oklch(0.68 0.14 ${hue} / ${selected ? 0.3 : 0.14})`,
    boxShadow: selected ? `inset 0 0 0 1.5px oklch(0.68 0.14 ${hue} / 0.9)` : undefined,
  };
}

function describeCounts(counts: SessionGroupCountSummary): string {
  const parts = [`${counts.live} ${counts.live === 1 ? "chat" : "chats"}`];
  if (counts.active > 0) parts.push(`${counts.active} working`);
  if (counts.waiting > 0) parts.push(`${counts.waiting} need you`);
  if (counts.unseen > 0) parts.push(`${counts.unseen} unread`);
  return parts.join(" · ");
}

export function SessionGroupsRail({
  state,
  onSelect = state.setSelection,
  activeThreadRef = null,
}: {
  readonly state: GroupsState;
  readonly onSelect?: (selection: SessionGroupSelection | null) => void;
  /** The open chat, offered as "Add open chat" in a group's menu. */
  readonly activeThreadRef?: ScopedThreadRef | null;
}) {
  const [dialog, setDialog] = useState<RailDialog | null>(null);
  const [menuError, setMenuError] = useState<string | null>(null);
  const { environments } = useEnvironments();
  const label = (id: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === id)?.label ?? id;
  if (state.environments.length === 0 && state.selection === null) return null;
  const canOperate = (environmentId: EnvironmentId) =>
    state.environments.some(
      (environment) => environment.environmentId === environmentId && environment.canOperate,
    );
  const showEnvironment = state.environments.length > 1;

  const openGroupMenu = async (event: MouseEvent, target: GroupTarget, index: number) => {
    event.preventDefault();
    const api = readLocalApi();
    if (!api) {
      setDialog({ kind: "manage" });
      return;
    }
    const siblings = state.entries.filter((entry) => entry.environmentId === target.environmentId);
    const operable = canOperate(target.environmentId);
    const openChatHere =
      activeThreadRef !== null && activeThreadRef.environmentId === target.environmentId;
    const isMember =
      openChatHere && sessionGroupContainsThread(target.group, activeThreadRef.threadId);
    const position = { x: event.clientX, y: event.clientY };
    const clicked = await api.contextMenu.show(
      [
        ...(openChatHere
          ? [
              {
                id: "toggle-open-chat" as const,
                label: isMember ? "Remove open chat from group" : "Add open chat to group",
                disabled: !operable,
              },
            ]
          : []),
        {
          id: "rename" as const,
          label: "Rename…",
          disabled: !operable,
          separatorBefore: openChatHere,
        },
        { id: "move-up" as const, label: "Move up", disabled: !operable || index === 0 },
        {
          id: "move-down" as const,
          label: "Move down",
          disabled: !operable || index === siblings.length - 1,
        },
        { id: "manage" as const, label: "Manage groups…", separatorBefore: true },
        {
          id: "delete" as const,
          label: "Delete group…",
          destructive: true,
          disabled: !operable,
        },
      ],
      position,
    );
    if (clicked === null) return;
    const update = async (input: SessionGroupsUpdate) => {
      setMenuError(null);
      const result = await state.update({ environmentId: target.environmentId, input });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setMenuError(cause instanceof Error ? cause.message : "Could not update the group.");
      }
    };
    switch (clicked) {
      case "toggle-open-chat":
        if (activeThreadRef !== null)
          await update({
            type: "membership",
            id: target.group.id,
            threadId: activeThreadRef.threadId,
            member: !isMember,
          });
        return;
      case "rename":
        setDialog({ kind: "rename", target });
        return;
      case "move-up":
      case "move-down": {
        const ids = siblings.map((entry) => entry.group.id);
        const other = index + (clicked === "move-up" ? -1 : 1);
        [ids[index], ids[other]] = [ids[other]!, ids[index]!];
        await update({ type: "reorder", ids });
        return;
      }
      case "manage":
        setDialog({ kind: "manage" });
        return;
      case "delete":
        setDialog({ kind: "delete", target });
        return;
    }
  };

  const attention = state.entries.reduce((sum, entry) => sum + entry.counts.waiting, 0);
  return (
    <>
      <TooltipProvider>
        <nav
          aria-label="Session groups"
          className="flex w-14 shrink-0 scrollbar-gutter-both flex-col items-center gap-1.5 overflow-y-auto border-r border-sidebar-border px-1.5 py-2"
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-pressed={state.selection === null}
                  aria-label="Show chats from all groups"
                  className="relative flex size-11 shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg text-sidebar-muted-foreground hover:bg-sidebar-row-hover aria-pressed:bg-sidebar-row-selected aria-pressed:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => onSelect(null)}
                />
              }
            >
              <LayersIcon className="size-4" />
              <span className="text-3xs font-medium">All</span>
              {attention > 0 && state.selection !== null ? (
                <AttentionBadge count={attention} />
              ) : null}
            </TooltipTrigger>
            <TooltipPopup side="right">All chats</TooltipPopup>
          </Tooltip>
          <div aria-hidden className="h-px w-7 shrink-0 bg-sidebar-border" />
          {state.environments.map((environment) => {
            const entries = state.entries.filter(
              (entry) => entry.environmentId === environment.environmentId,
            );
            return (
              <div
                key={environment.environmentId}
                role="group"
                aria-label={label(environment.environmentId)}
                className="flex flex-col items-center gap-1.5"
              >
                {showEnvironment ? (
                  <span className="w-full truncate text-center text-3xs text-sidebar-muted-foreground">
                    {label(environment.environmentId)}
                  </span>
                ) : null}
                {!environment.loaded ? (
                  <span
                    role="status"
                    aria-label={
                      environment.canRead ? "Loading groups" : "This connection cannot read groups"
                    }
                    className="size-11 shrink-0 rounded-lg bg-sidebar-row-hover"
                  />
                ) : null}
                {entries.map(({ group, counts }, index) => {
                  const selected =
                    state.selection?.environmentId === environment.environmentId &&
                    state.selection.id === group.id;
                  return (
                    <Tooltip key={group.id}>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            aria-pressed={selected}
                            aria-label={`${group.name}, ${describeCounts(counts)}`}
                            style={sessionGroupTint(group.id, selected)}
                            className="relative flex size-11 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground transition-colors focus-visible:outline-2 focus-visible:outline-ring"
                            onClick={() =>
                              onSelect(
                                selected
                                  ? null
                                  : { environmentId: environment.environmentId, id: group.id },
                              )
                            }
                            onContextMenu={(event) =>
                              void openGroupMenu(
                                event,
                                { environmentId: environment.environmentId, group },
                                index,
                              )
                            }
                          />
                        }
                      >
                        <span
                          className={cn(
                            "max-w-full truncate px-0.5 text-xs tracking-tight",
                            selected ? "font-bold" : "font-semibold",
                          )}
                        >
                          {sessionGroupBadgeLabel(group.name)}
                        </span>
                        {counts.waiting > 0 ? (
                          <AttentionBadge count={counts.waiting} />
                        ) : counts.unseen > 0 ? (
                          <span
                            aria-hidden
                            className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full border-2 border-sidebar bg-info"
                          />
                        ) : null}
                        {counts.active > 0 ? (
                          <span
                            aria-hidden
                            className="absolute right-1 bottom-1 size-1.5 rounded-full bg-success"
                          />
                        ) : null}
                      </TooltipTrigger>
                      <TooltipPopup side="right">
                        <span className="font-medium">{group.name}</span>
                        {showEnvironment ? ` · ${label(environment.environmentId)}` : null}
                        <br />
                        {describeCounts(counts)}
                        <br />
                        <span className="text-muted-foreground">
                          {selected ? "Click to show all · " : ""}Right-click for options
                        </span>
                      </TooltipPopup>
                    </Tooltip>
                  );
                })}
              </div>
            );
          })}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="New session group"
                  disabled={!state.environments.some((environment) => environment.canOperate)}
                  className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-dashed border-sidebar-border text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
                  onClick={() => setDialog({ kind: "create" })}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setDialog({ kind: "manage" });
                  }}
                />
              }
            >
              <PlusIcon className="size-4" />
            </TooltipTrigger>
            <TooltipPopup side="right">New group · right-click to manage</TooltipPopup>
          </Tooltip>
          {menuError ? (
            <p role="alert" className="text-center text-3xs text-destructive">
              {menuError}
            </p>
          ) : null}
        </nav>
      </TooltipProvider>
      {dialog?.kind === "manage" ? (
        <ManageSessionGroups state={state} label={label} close={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === "create" ? (
        <GroupNameDialog
          state={state}
          label={label}
          activeThreadRef={activeThreadRef}
          close={() => setDialog(null)}
          onCreated={(selection) => onSelect(selection)}
        />
      ) : null}
      {dialog?.kind === "rename" ? (
        <GroupNameDialog
          state={state}
          label={label}
          target={dialog.target}
          close={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "delete" ? (
        <DeleteGroupDialog state={state} target={dialog.target} close={() => setDialog(null)} />
      ) : null}
    </>
  );
}

function AttentionBadge({ count }: { readonly count: number }) {
  return (
    <span
      aria-hidden
      className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full border-2 border-sidebar bg-warning px-0.5 text-4xs leading-none font-bold text-warning-foreground tabular-nums"
    >
      {count > 9 ? "9+" : count}
    </span>
  );
}

function useGroupUpdate(state: GroupsState) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  return { busy, error, run };
}

/** Creates a group (optionally with the open chat in it) or renames one. */
function GroupNameDialog({
  state,
  label,
  target,
  activeThreadRef = null,
  close,
  onCreated,
}: {
  readonly state: GroupsState;
  readonly label: (id: EnvironmentId) => string;
  readonly target?: GroupTarget;
  readonly activeThreadRef?: ScopedThreadRef | null;
  readonly close: () => void;
  readonly onCreated?: (selection: SessionGroupSelection) => void;
}) {
  const nameId = useId();
  const environmentInputId = useId();
  const addChatId = useId();
  const { busy, error, run } = useGroupUpdate(state);
  const operable = state.environments.filter(
    (environment) => environment.canOperate && environment.loaded,
  );
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(
    target?.environmentId ??
      operable.find((environment) => environment.environmentId === activeThreadRef?.environmentId)
        ?.environmentId ??
      operable[0]?.environmentId ??
      null,
  );
  const [name, setName] = useState(target?.group.name ?? "");
  const [addOpenChat, setAddOpenChat] = useState(true);
  const canAddOpenChat =
    target === undefined &&
    activeThreadRef !== null &&
    activeThreadRef.environmentId === environmentId;
  const trimmed = name.trim();
  const submit = async () => {
    if (environmentId === null || !trimmed) return;
    if (target) {
      if (
        trimmed === target.group.name ||
        (await run(environmentId, {
          type: "rename",
          id: target.group.id,
          name: trimmed,
        }))
      )
        close();
      return;
    }
    const id = randomUUID();
    if (!(await run(environmentId, { type: "create", id, name: trimmed }))) return;
    if (canAddOpenChat && addOpenChat && activeThreadRef !== null) {
      await run(environmentId, {
        type: "membership",
        id,
        threadId: activeThreadRef.threadId,
        member: true,
      });
    }
    onCreated?.({ environmentId, id });
    close();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="max-w-sm">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {target ? `Rename ${target.group.name}` : "New session group"}
            </DialogTitle>
            <DialogDescription>
              {target
                ? "The group keeps its chats and color."
                : "Short names such as FNF show in full on the rail."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              {!target && operable.length > 1 ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={environmentInputId}>Environment</Label>
                  <select
                    id={environmentInputId}
                    value={environmentId ?? ""}
                    disabled={busy}
                    className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                    onChange={(event) =>
                      setEnvironmentId(
                        operable.find(
                          (environment) => environment.environmentId === event.target.value,
                        )?.environmentId ?? null,
                      )
                    }
                  >
                    {operable.map((environment) => (
                      <option key={environment.environmentId} value={environment.environmentId}>
                        {label(environment.environmentId)}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={nameId}>Name</Label>
                <Input
                  id={nameId}
                  value={name}
                  autoFocus
                  maxLength={80}
                  disabled={busy || environmentId === null}
                  placeholder="e.g. FNF"
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              {canAddOpenChat ? (
                <label htmlFor={addChatId} className="flex items-center gap-2 text-sm">
                  <input
                    id={addChatId}
                    type="checkbox"
                    checked={addOpenChat}
                    disabled={busy}
                    onChange={(event) => setAddOpenChat(event.target.checked)}
                  />
                  Add the open chat to this group
                </label>
              ) : null}
              {environmentId === null ? (
                <p className="text-sm text-muted-foreground">
                  No connected environment can save session groups.
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !trimmed || environmentId === null}>
              {target ? "Save" : "Create group"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function DeleteGroupDialog({
  state,
  target,
  close,
}: {
  readonly state: GroupsState;
  readonly target: GroupTarget;
  readonly close: () => void;
}) {
  const { busy, error, run } = useGroupUpdate(state);
  const operable = state.environments.some(
    (environment) => environment.environmentId === target.environmentId && environment.canOperate,
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete {target.group.name}?</DialogTitle>
          <DialogDescription>
            Chats stay in their projects. Only this group is removed.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <DialogPanel>
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          </DialogPanel>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={busy || !operable}
            onClick={() => {
              void run(target.environmentId, { type: "delete", id: target.group.id }).then((ok) => {
                if (ok) close();
              });
            }}
          >
            Delete group
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
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
  const { busy, error, run } = useGroupUpdate(state);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<GroupTarget | null>(null);
  if (creating)
    return <GroupNameDialog state={state} label={label} close={() => setCreating(false)} />;
  if (deleting)
    return <DeleteGroupDialog state={state} target={deleting} close={() => setDeleting(null)} />;
  const showEnvironment = state.environments.length > 1;
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
            Group chats across projects and providers. A chat can belong to several groups.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            {state.environments.map((environment) => {
              const entries = state.entries.filter(
                (entry) => entry.environmentId === environment.environmentId,
              );
              return (
                <section
                  key={environment.environmentId}
                  aria-label={label(environment.environmentId)}
                  className="flex flex-col gap-1"
                >
                  {showEnvironment ? (
                    <p className="mb-1 text-xs text-muted-foreground">
                      {label(environment.environmentId)}
                    </p>
                  ) : null}
                  {!environment.loaded ? (
                    <p role="status" className="text-sm">
                      {environment.canRead
                        ? "Loading groups…"
                        : "This connection cannot read session groups."}
                    </p>
                  ) : entries.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No groups yet.</p>
                  ) : null}
                  {entries.map(({ group, counts }, index) => (
                    <GroupRow
                      key={group.id}
                      group={group}
                      counts={counts}
                      disabled={busy || !environment.canOperate}
                      canMoveUp={index > 0}
                      canMoveDown={index < entries.length - 1}
                      onRename={(name) =>
                        run(environment.environmentId, { type: "rename", id: group.id, name })
                      }
                      onMove={(direction) => {
                        const ids = entries.map((entry) => entry.group.id);
                        const other = index + direction;
                        [ids[index], ids[other]] = [ids[other]!, ids[index]!];
                        void run(environment.environmentId, { type: "reorder", ids });
                      }}
                      onDelete={() =>
                        setDeleting({ environmentId: environment.environmentId, group })
                      }
                    />
                  ))}
                </section>
              );
            })}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={!state.environments.some((environment) => environment.canOperate)}
            onClick={() => setCreating(true)}
          >
            <PlusIcon />
            New group
          </Button>
          <Button onClick={close}>Done</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function GroupRow({
  group,
  counts,
  disabled,
  canMoveUp,
  canMoveDown,
  onRename,
  onMove,
  onDelete,
}: {
  readonly group: SessionGroup;
  readonly counts: SessionGroupCountSummary;
  readonly disabled: boolean;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly onRename: (name: string) => Promise<boolean>;
  readonly onMove: (direction: -1 | 1) => void;
  readonly onDelete: () => void;
}) {
  const [draftName, setDraftName] = useState<string | null>(null);
  const name = draftName ?? group.name;
  const commit = () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === group.name) {
      setDraftName(null);
      return;
    }
    void onRename(trimmed).then((ok) => {
      if (ok) setDraftName(null);
    });
  };
  return (
    <form
      className="flex items-center gap-2 rounded-md py-1"
      onSubmit={(event) => {
        event.preventDefault();
        commit();
      }}
    >
      <span
        aria-hidden
        style={sessionGroupTint(group.id, true)}
        className="flex size-8 shrink-0 items-center justify-center rounded-md text-2xs font-semibold"
      >
        {sessionGroupBadgeLabel(name || group.name)}
      </span>
      <Input
        aria-label={`Name of ${group.name}`}
        value={name}
        disabled={disabled}
        maxLength={80}
        className="min-w-0 flex-1"
        onChange={(event) => setDraftName(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Escape" && draftName !== null) {
            event.preventDefault();
            setDraftName(null);
          }
        }}
      />
      <span className="w-14 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
        {counts.live} {counts.live === 1 ? "chat" : "chats"}
      </span>
      <Button
        size="icon-sm"
        type="button"
        variant="ghost"
        disabled={disabled || !canMoveUp}
        aria-label={`Move ${group.name} up`}
        onClick={() => onMove(-1)}
      >
        <ArrowUpIcon />
      </Button>
      <Button
        size="icon-sm"
        type="button"
        variant="ghost"
        disabled={disabled || !canMoveDown}
        aria-label={`Move ${group.name} down`}
        onClick={() => onMove(1)}
      >
        <ArrowDownIcon />
      </Button>
      <Button
        size="icon-sm"
        type="button"
        variant="ghost-destructive"
        disabled={disabled}
        aria-label={`Delete ${group.name}`}
        onClick={onDelete}
      >
        <Trash2Icon />
      </Button>
    </form>
  );
}
