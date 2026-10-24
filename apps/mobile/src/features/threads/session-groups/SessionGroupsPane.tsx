import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useState, type ReactNode } from "react";
import { View } from "react-native";
import { AppText } from "../../../components/ui/AppText";
import { SessionGroupManager } from "./SessionGroupManager";
import { SessionGroupRail } from "./SessionGroupRail";
import type { SessionGroupSelection } from "./selection";
import type { MobileSessionGroupEditor } from "./types";
import type { useMobileSessionGroups } from "./use-mobile-session-groups";

/** Put beside the list, with the unfiltered shell array retained for counts/membership. */
export function SessionGroupsPane(props: {
  readonly state: ReturnType<typeof useMobileSessionGroups>;
  readonly threads: readonly EnvironmentThreadShell[];
  readonly children: ReactNode;
  /** Clear existing project/environment filters when selecting a group or All. */
  readonly onSelect?: (selection: SessionGroupSelection | null) => void;
  readonly railTopInset?: number;
  readonly railBottomInset?: number;
}) {
  const [editor, setEditor] = useState<MobileSessionGroupEditor | null>(null);
  const editingEnvironment = props.state.environments.find(
    (environment) => environment.environmentId === editor?.environmentId,
  );
  return (
    <View className="flex-1 flex-row">
      {(props.state.environments.length > 0 || props.state.selection !== null) && (
        <SessionGroupRail
          environments={props.state.environments}
          threads={props.threads}
          selection={props.state.selection}
          onSelect={
            props.onSelect ??
            ((selection) => {
              void props.state.select(selection);
            })
          }
          onEdit={setEditor}
          topInset={props.railTopInset}
          bottomInset={props.railBottomInset}
        />
      )}
      <View className="min-w-0 flex-1">
        {props.state.error && (
          <AppText accessibilityRole="alert" className="px-3 py-2 text-sm text-danger-foreground">
            {props.state.error}
          </AppText>
        )}
        {props.children}
      </View>
      {editor && editingEnvironment && (
        <SessionGroupManager
          key={JSON.stringify([editor.environmentId, editor.groupId])}
          environment={editingEnvironment}
          groupId={editor.groupId}
          threads={props.threads}
          onClose={() => setEditor(null)}
        />
      )}
    </View>
  );
}
