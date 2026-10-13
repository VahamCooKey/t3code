import { randomUUID } from "../lib/utils";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  ProjectId,
  type EnvironmentId,
  type ProjectCopyInput,
} from "@t3tools/contracts";
import { useCallback, useRef } from "react";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { waitForProject } from "../state/entities";
import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";
import { useNewThreadHandler } from "./useHandleNewThread";

export function useCopyProject() {
  const copy = useAtomCommand(projectEnvironment.copy, { reportFailure: false });
  const newThread = useNewThreadHandler();
  const inFlight = useRef(false);
  return useCallback(
    async (
      project: { environmentId: EnvironmentId; id: ProjectId; title: string },
      mode: ProjectCopyInput["mode"],
    ) => {
      if (inFlight.current) return;
      inFlight.current = true;
      const progress = toastManager.add({
        type: "loading",
        title: mode === "duplicate" ? "Duplicating project" : "Branching project",
      });
      try {
        const result = await copy({
          environmentId: project.environmentId,
          input: {
            commandId: CommandId.make(randomUUID()),
            sourceProjectId: project.id,
            targetProjectId: ProjectId.make(randomUUID()),
            name: `${project.title} ${mode === "duplicate" ? "copy" : "branch"}`.slice(0, 200),
            mode,
          },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.update(
              progress,
              stackedThreadToast({
                type: "error",
                title: "Could not copy project",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          } else toastManager.close(progress);
          return;
        }
        toastManager.update(
          progress,
          stackedThreadToast({
            type: "success",
            title: mode === "duplicate" ? "Project duplicated" : "Project branched",
            description: result.value.workspaceRoot,
          }),
        );
        const projectRef = scopeProjectRef(project.environmentId, result.value.projectId);
        try {
          await waitForProject(projectRef);
          await newThread(projectRef, {
            branch: result.value.branch,
            envMode: "local",
            startFromOrigin: false,
          });
        } catch {
          toastManager.add(
            stackedThreadToast({
              type: "warning",
              title: "Project created",
              description: "Open it from the sidebar when this client reconnects.",
            }),
          );
        }
      } finally {
        inFlight.current = false;
      }
    },
    [copy, newThread],
  );
}
