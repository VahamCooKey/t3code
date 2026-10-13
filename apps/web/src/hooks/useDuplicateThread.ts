import { randomUUID } from "../lib/utils";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CommandId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { waitForThreadShell } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";

/** Copies the server's full conversation, even when its history is not loaded here. */
export function useDuplicateThread() {
  const duplicate = useAtomCommand(threadEnvironment.duplicate, { reportFailure: false });
  const router = useRouter();
  return useCallback(
    async (source: ScopedThreadRef) => {
      const targetThreadId = ThreadId.make(randomUUID());
      const result = await duplicate({
        environmentId: source.environmentId,
        input: {
          commandId: CommandId.make(randomUUID()),
          sourceThreadId: source.threadId,
          targetThreadId,
          creationSource: "web",
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not duplicate session",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }
      const target = scopeThreadRef(source.environmentId, targetThreadId);
      if (!(await waitForThreadShell(target))) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Session duplicated",
            description: "Open the copy from the sidebar when this client reconnects.",
          }),
        );
        return;
      }
      await router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(target),
      });
    },
    [duplicate, router],
  );
}
