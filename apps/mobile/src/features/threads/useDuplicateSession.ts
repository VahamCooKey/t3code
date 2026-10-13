import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { CommandId, ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useCallback } from "react";
import { Alert } from "react-native";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom } from "../../state/server";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { waitForThreadShellReady } from "./threadForkNavigation";

export function useDuplicateSession(environmentId: EnvironmentId) {
  const duplicate = useAtomCommand(threadEnvironment.duplicate, "duplicate session");
  const permission = useAtomValue(threadEnvironment.duplicate.permissionAtom(environmentId));
  const configs = useAtomValue(environmentServerConfigsAtom);
  const supported = configs.get(environmentId)?.environment.capabilities.threadDuplication === true;
  const navigation = useNavigation();
  const duplicateSession = useCallback(
    async (sourceThreadId: ThreadId) => {
      const targetThreadId = ThreadId.make(uuidv4());
      const result = await duplicate({
        environmentId,
        input: {
          commandId: CommandId.make(uuidv4()),
          sourceThreadId,
          targetThreadId,
          creationSource: "mobile",
        },
      });
      if (result._tag !== "Success") return;
      const atom = environmentThreadShells.threadShellAtom(
        scopeThreadRef(environmentId, targetThreadId),
      );
      if (!(await waitForThreadShellReady({ read: () => appAtomRegistry.get(atom) !== null }))) {
        Alert.alert(
          "Session duplicated",
          "Open the copy from the thread list when this client reconnects.",
        );
        return;
      }
      navigation.navigate("Thread", { environmentId, threadId: targetThreadId });
    },
    [duplicate, environmentId, navigation],
  );
  return { duplicateSession, supported, canDuplicate: permission && supported };
}
