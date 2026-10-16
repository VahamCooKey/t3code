import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { AuthOrchestrationOperateScope, type SessionGroupId } from "@t3tools/contracts";
import { useMemo, useRef, useState } from "react";
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  TextInput,
  View,
} from "react-native";
import { AppText } from "../../../components/ui/AppText";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { ControlPill } from "../../../components/ui/ControlPill";
import { useEnvironmentScope } from "../../../state/session";
import { reorderedSessionGroupIds } from "./selection";
import type { MobileSessionGroupEnvironment } from "./types";

/** Remount with environmentId + groupId as the key when changing the edited group. */
export function SessionGroupManager(props: {
  readonly environment: MobileSessionGroupEnvironment;
  readonly groupId: SessionGroupId | null;
  readonly threads: readonly EnvironmentThreadShell[];
  readonly onClose: () => void;
}) {
  const { environment, groupId } = props;
  const group = environment.groups?.find((item) => item.id === groupId);
  const [name, setName] = useState(group?.name ?? "");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const canOperate = useEnvironmentScope(environment.environmentId, AuthOrchestrationOperateScope);
  const canUpdate =
    canOperate &&
    environment.commands.canUpdate &&
    environment.groups !== null &&
    (groupId === null || group !== undefined);
  const threads = useMemo(
    () =>
      props.threads.filter(
        (thread) =>
          thread.environmentId === environment.environmentId && thread.archivedAt === null,
      ),
    [props.threads, environment.environmentId],
  );

  const run = async (action: () => Promise<void>, close = false) => {
    if (!canUpdate || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
      if (close) props.onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update the group. Try again.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const move = (direction: "up" | "down") => {
    if (!group) return;
    const ids = reorderedSessionGroupIds(environment.groups ?? [], group.id, direction);
    if (ids) void run(() => environment.commands.reorder(ids));
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={props.onClose}>
      <KeyboardAvoidingView
        className="flex-1 items-center justify-center bg-backdrop px-5"
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View className="max-h-[85%] w-full max-w-md gap-4 rounded-3xl bg-screen p-5">
          <AppText accessibilityRole="header" className="text-xl font-t3-semibold">
            {groupId === null ? "Create group" : "Manage group"}
          </AppText>
          <AppText className="text-sm text-foreground-muted">{environment.label}</AppText>
          {groupId !== null && !group && (
            <AppText accessibilityRole="alert">This group is no longer available.</AppText>
          )}
          <TextInput
            accessibilityLabel="Group name"
            className="min-h-12 rounded-xl bg-subtle px-3 text-base text-foreground"
            value={name}
            onChangeText={setName}
            editable={canUpdate && !busy}
            autoFocus={groupId === null}
            autoCapitalize="sentences"
            returnKeyType="done"
            onSubmitEditing={() => {
              if (!name.trim()) return;
              void run(
                () =>
                  groupId === null
                    ? environment.commands.create(name.trim())
                    : environment.commands.rename(groupId, name.trim()),
                true,
              );
            }}
          />
          {group && (
            <View className="flex-row items-center justify-between gap-2">
              <ControlPill
                icon="arrow.up"
                accessibilityLabel="Move group up"
                disabled={
                  !canUpdate ||
                  busy ||
                  !reorderedSessionGroupIds(environment.groups ?? [], group.id, "up")
                }
                onPress={() => move("up")}
              />
              <ControlPill
                icon="arrow.down"
                accessibilityLabel="Move group down"
                disabled={
                  !canUpdate ||
                  busy ||
                  !reorderedSessionGroupIds(environment.groups ?? [], group.id, "down")
                }
                onPress={() => move("down")}
              />
              <ControlPill
                icon="trash"
                variant="danger"
                accessibilityLabel="Delete group"
                disabled={!canUpdate || busy}
                onPress={() => {
                  Alert.alert(
                    `Delete ${group.name}?`,
                    "Your chats will be kept. Only the group is removed.",
                    [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Delete group",
                        style: "destructive",
                        onPress: () => {
                          void run(() => environment.commands.delete(group.id), true);
                        },
                      },
                    ],
                  );
                }}
              />
            </View>
          )}
          {group && (
            <>
              <AppText className="font-t3-semibold">Chats in this group</AppText>
              <AppText className="text-sm text-foreground-muted">
                Chats can belong to more than one group.
              </AppText>
              <FlatList
                style={{ flexGrow: 0, flexShrink: 1, minHeight: 48 }}
                data={threads}
                extraData={{ threadIds: group.threadIds, busy, canUpdate }}
                keyExtractor={(thread) => thread.id}
                keyboardShouldPersistTaps="handled"
                initialNumToRender={12}
                ListEmptyComponent={
                  <AppText className="py-3 text-foreground-muted">
                    No chats in this environment.
                  </AppText>
                }
                renderItem={({ item: thread }) => {
                  const member = group.threadIds.includes(thread.id);
                  return (
                    <Pressable
                      accessibilityRole="checkbox"
                      accessibilityLabel={thread.title}
                      accessibilityState={{ checked: member, disabled: !canUpdate || busy }}
                      disabled={!canUpdate || busy}
                      className="min-h-12 flex-row items-center gap-3 border-b border-border-subtle py-3"
                      onPress={() => {
                        void run(() =>
                          environment.commands.membership(group.id, thread.id, !member),
                        );
                      }}
                    >
                      <SymbolView
                        name={member ? "checkmark" : "plus"}
                        size={18}
                        tintColorClassName="accent-foreground"
                      />
                      <AppText className="flex-1" numberOfLines={2}>
                        {thread.title}
                      </AppText>
                    </Pressable>
                  );
                }}
              />
            </>
          )}
          {error && (
            <AppText accessibilityRole="alert" className="text-danger-foreground">
              {error}
            </AppText>
          )}
          {!canUpdate && (
            <AppText className="text-sm text-foreground-muted">
              Group changes are unavailable for this environment.
            </AppText>
          )}
          <View className="flex-row justify-end gap-3">
            <ControlPill label="Close" variant="pill" onPress={props.onClose} />
            <ControlPill
              label={busy ? "Saving…" : groupId === null ? "Create" : "Save name"}
              variant="primary"
              disabled={!canUpdate || busy || !name.trim()}
              onPress={() => {
                void run(
                  () =>
                    groupId === null
                      ? environment.commands.create(name.trim())
                      : environment.commands.rename(groupId, name.trim()),
                  true,
                );
              }}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
