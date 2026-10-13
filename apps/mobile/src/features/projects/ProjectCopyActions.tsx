import { useAtomValue } from "@effect/atom-react";
import { CommandId, ProjectId, type ProjectCopyInput } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { uuidv4 } from "../../lib/uuid";
import { AppText as Text } from "../../components/AppText";
import { projectEnvironment } from "../../state/projects";
import { environmentServerConfigsAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

export function ProjectCopyActions({ project }: { readonly project: EnvironmentProject }) {
  const copy = useAtomCommand(projectEnvironment.copy, "copy project");
  const canCopy = useAtomValue(projectEnvironment.copy.permissionAtom(project.environmentId));
  const configs = useAtomValue(environmentServerConfigsAtom);
  const [busy, setBusy] = useState(false);
  if (configs.get(project.environmentId)?.environment.capabilities.projectCopy !== true)
    return null;
  const copyProject = async (mode: ProjectCopyInput["mode"]) => {
    setBusy(true);
    try {
      const result = await copy({
        environmentId: project.environmentId,
        input: {
          commandId: CommandId.make(uuidv4()),
          sourceProjectId: project.id,
          targetProjectId: ProjectId.make(uuidv4()),
          name: `${project.title} ${mode === "duplicate" ? "copy" : "branch"}`.slice(0, 200),
          mode,
        },
      });
      if (result._tag === "Success")
        Alert.alert(
          mode === "duplicate" ? "Project duplicated" : "Project branched",
          result.value.workspaceRoot,
        );
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="gap-2 pt-3">
      <Text className="text-sm text-foreground-muted">
        Duplicate copies current files. Branch creates a worktree from the latest commit. Sessions
        stay in this project.
      </Text>
      <View className="flex-row gap-3">
        {(["duplicate", "branch"] as const).map((mode) => (
          <Pressable
            key={mode}
            accessibilityRole="button"
            disabled={!canCopy || busy}
            onPress={() => void copyProject(mode)}
            className="rounded-full bg-subtle-strong px-4 py-2 disabled:opacity-40 active:opacity-70"
          >
            <Text className="text-sm font-t3-medium text-foreground">
              {mode === "duplicate" ? "Duplicate project" : "Branch project"}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
