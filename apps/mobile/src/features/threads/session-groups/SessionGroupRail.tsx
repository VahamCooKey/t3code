import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { memo, useMemo } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { AppText } from "../../../components/ui/AppText";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { cn } from "../../../lib/cn";
import { useEnvironmentScope } from "../../../state/session";
import {
  sessionGroupAbbreviation,
  sessionGroupStatusCounts,
  type SessionGroupSelection,
} from "./selection";
import type { MobileSessionGroupEditor, MobileSessionGroupEnvironment } from "./types";

export const SESSION_GROUP_RAIL_WIDTH = 76;

export const SessionGroupRail = memo(function SessionGroupRail(props: {
  readonly environments: readonly MobileSessionGroupEnvironment[];
  readonly threads: readonly EnvironmentThreadShell[];
  readonly selection: SessionGroupSelection | null;
  readonly onSelect: (selection: SessionGroupSelection | null) => void;
  readonly onEdit: (editor: MobileSessionGroupEditor) => void;
  readonly topInset?: number;
  readonly bottomInset?: number;
}) {
  return (
    <View
      className="border-r border-border-subtle bg-drawer"
      style={{
        width: SESSION_GROUP_RAIL_WIDTH,
        paddingTop: props.topInset,
        paddingBottom: props.bottomInset,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="All chats"
        accessibilityState={{ selected: props.selection === null }}
        className={cn(
          "min-h-12 items-center justify-center px-1 py-3",
          props.selection === null && "bg-thread-selected",
        )}
        onPress={() => props.onSelect(null)}
      >
        <AppText
          className={
            props.selection === null
              ? "font-t3-bold text-thread-selected-foreground"
              : "font-t3-bold text-drawer-foreground"
          }
        >
          All
        </AppText>
      </Pressable>
      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 12 }}>
        {props.environments.map((environment) => (
          <EnvironmentGroups
            key={environment.environmentId}
            environment={environment}
            threads={props.threads}
            selection={props.selection}
            showEnvironmentLabel={props.environments.length > 1}
            onSelect={props.onSelect}
            onEdit={props.onEdit}
          />
        ))}
      </ScrollView>
    </View>
  );
});

function EnvironmentGroups(props: {
  readonly environment: MobileSessionGroupEnvironment;
  readonly threads: readonly EnvironmentThreadShell[];
  readonly selection: SessionGroupSelection | null;
  readonly showEnvironmentLabel: boolean;
  readonly onSelect: (selection: SessionGroupSelection | null) => void;
  readonly onEdit: (editor: MobileSessionGroupEditor) => void;
}) {
  const { environment } = props;
  const canOperate = useEnvironmentScope(environment.environmentId, AuthOrchestrationOperateScope);
  const canUpdate = canOperate && environment.commands.canUpdate && environment.groups !== null;
  const counts = useMemo(
    () =>
      sessionGroupStatusCounts(environment.groups ?? [], environment.environmentId, props.threads),
    [environment.groups, environment.environmentId, props.threads],
  );
  return (
    <View>
      {props.showEnvironmentLabel && (
        <AppText className="px-1 py-2 text-center text-xs text-drawer-foreground-muted">
          {environment.label}
        </AppText>
      )}
      {environment.groups === null && (
        <AppText className="px-1 py-2 text-center text-xs text-drawer-foreground-muted">
          {environment.error ?? "Loading"}
        </AppText>
      )}
      {environment.groups?.map((group) => {
        const selected =
          props.selection?.environmentId === environment.environmentId &&
          props.selection.groupId === group.id;
        const status = counts.get(group.id)!;
        return (
          <View
            key={group.id}
            className={cn("items-center px-1 py-2", selected && "bg-thread-selected")}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${group.name}, ${status.active} active, ${status.waiting} waiting`}
              accessibilityState={{ selected }}
              accessibilityHint={
                canUpdate ? "Selects this group. Long press to manage it." : "Selects this group"
              }
              className="min-h-11 w-full items-center justify-center gap-1"
              onPress={() =>
                props.onSelect({ environmentId: environment.environmentId, groupId: group.id })
              }
              onLongPress={
                canUpdate
                  ? () =>
                      props.onEdit({ environmentId: environment.environmentId, groupId: group.id })
                  : undefined
              }
            >
              <AppText
                className={cn(
                  "text-sm font-t3-bold",
                  selected ? "text-thread-selected-foreground" : "text-drawer-foreground",
                )}
              >
                {sessionGroupAbbreviation(group.name)}
              </AppText>
              <AppText
                className={cn(
                  "text-center text-xs",
                  selected ? "text-thread-selected-foreground" : "text-drawer-foreground",
                )}
              >
                {group.name}
              </AppText>
              <AppText
                className={cn(
                  "text-center text-xs tabular-nums",
                  selected ? "text-thread-selected-foreground" : "text-drawer-foreground-muted",
                )}
              >
                {status.active} active{"\n"}
                {status.waiting} waiting
              </AppText>
            </Pressable>
            {canUpdate && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Manage ${group.name}`}
                className="min-h-11 w-full items-center justify-center"
                onPress={() =>
                  props.onEdit({ environmentId: environment.environmentId, groupId: group.id })
                }
              >
                <SymbolView
                  name="ellipsis"
                  size={16}
                  tintColorClassName={
                    selected
                      ? "accent-thread-selected-foreground"
                      : "accent-drawer-foreground-muted"
                  }
                />
              </Pressable>
            )}
          </View>
        );
      })}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Create group in ${environment.label}`}
        accessibilityState={{ disabled: !canUpdate }}
        disabled={!canUpdate}
        className={cn("min-h-12 items-center justify-center py-2", !canUpdate && "opacity-40")}
        onPress={() => props.onEdit({ environmentId: environment.environmentId, groupId: null })}
      >
        <SymbolView name="plus" size={18} tintColorClassName="accent-drawer-foreground" />
      </Pressable>
    </View>
  );
}
