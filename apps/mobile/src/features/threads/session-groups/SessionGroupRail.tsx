import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { memo, useMemo } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { AppText } from "../../../components/ui/AppText";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { cn } from "../../../lib/cn";
import { useEnvironmentScope } from "../../../state/session";
import {
  sessionGroupBadgeLabel,
  sessionGroupHue,
} from "@t3tools/client-runtime/state/sessionGroupLogic";
import { sessionGroupStatusCounts, type SessionGroupSelection } from "./selection";
import type { MobileSessionGroupEditor, MobileSessionGroupEnvironment } from "./types";

export const SESSION_GROUP_RAIL_WIDTH = 64;

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
        const hue = sessionGroupHue(group.id);
        const summary = [
          `${status.live} ${status.live === 1 ? "chat" : "chats"}`,
          status.active > 0 ? `${status.active} working` : null,
          status.waiting > 0 ? `${status.waiting} need you` : null,
          status.unseen > 0 ? `${status.unseen} unread` : null,
        ]
          .filter((part) => part !== null)
          .join(", ");
        return (
          <View key={group.id} className="items-center px-1.5 py-1">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${group.name}, ${summary}`}
              accessibilityState={{ selected }}
              accessibilityHint={
                canUpdate ? "Selects this group. Long press to manage it." : "Selects this group"
              }
              className="h-12 w-full items-center justify-center rounded-xl"
              style={{
                backgroundColor: `hsla(${hue}, 65%, 55%, ${selected ? 0.32 : 0.16})`,
                borderWidth: selected ? 1.5 : 0,
                borderColor: `hsla(${hue}, 65%, 55%, 0.9)`,
              }}
              onPress={() =>
                props.onSelect(
                  selected ? null : { environmentId: environment.environmentId, groupId: group.id },
                )
              }
              onLongPress={
                canUpdate
                  ? () =>
                      props.onEdit({ environmentId: environment.environmentId, groupId: group.id })
                  : undefined
              }
            >
              <AppText
                numberOfLines={1}
                className={cn(
                  "px-0.5 text-sm",
                  selected ? "font-t3-bold text-drawer-foreground" : "text-drawer-foreground",
                )}
              >
                {sessionGroupBadgeLabel(group.name)}
              </AppText>
              {status.waiting > 0 ? (
                <View className="absolute -top-1 -right-1 h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1">
                  <AppText className="text-3xs font-t3-bold text-white tabular-nums">
                    {status.waiting > 9 ? "9+" : status.waiting}
                  </AppText>
                </View>
              ) : status.unseen > 0 ? (
                <View className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-sky-500" />
              ) : null}
              {status.active > 0 ? (
                <View className="absolute right-1.5 bottom-1.5 size-1.5 rounded-full bg-emerald-500" />
              ) : null}
            </Pressable>
            {selected && canUpdate ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Manage ${group.name}`}
                className="min-h-9 w-full items-center justify-center"
                onPress={() =>
                  props.onEdit({ environmentId: environment.environmentId, groupId: group.id })
                }
              >
                <SymbolView
                  name="ellipsis"
                  size={16}
                  tintColorClassName="accent-drawer-foreground-muted"
                />
              </Pressable>
            ) : null}
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
