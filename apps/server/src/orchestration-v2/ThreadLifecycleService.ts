import {
  CommandId,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2DuplicateThreadInput,
  type ProviderInteractionMode,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ThreadManagement from "./ThreadManagementService.ts";
import { isForkableSourceRunStatus } from "./ThreadForkService.ts";

class ThreadDuplicateRejected extends Schema.TaggedError<ThreadDuplicateRejected>()(
  "ThreadDuplicateRejected",
  {
    reason: Schema.Literals([
      "same_thread",
      "previous_failed",
      "deleted",
      "lineage_cycle",
      "unfinished",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "same_thread":
        return "The copy needs a new thread ID.";
      case "previous_failed":
        return "The previous duplication request did not create a session.";
      case "deleted":
        return "The source thread was deleted.";
      case "lineage_cycle":
        return "The conversation lineage contains a cycle.";
      case "unfinished":
        return "Wait for the session to finish and clear its queued messages before duplicating it.";
    }
  }
}

export class ThreadLifecycleError extends Schema.TaggedError<ThreadLifecycleError>()(
  "ThreadLifecycleError",
  {
    operation: Schema.Literals([
      "archive",
      "unarchive",
      "delete",
      "update-metadata",
      "set-runtime-mode",
      "set-interaction-mode",
      "set-model-selection",
      "duplicate",
    ]),
    threadId: ThreadId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread lifecycle operation '${this.operation}' failed for ${this.threadId}.`;
  }
}

export class ThreadLifecycleService extends Context.Service<
  ThreadLifecycleService,
  {
    readonly duplicate: (
      input: OrchestrationV2DuplicateThreadInput,
    ) => Effect.Effect<void, ThreadLifecycleError>;
    readonly archive: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<Pick<OrchestrationV2ThreadProjection, "thread">, ThreadLifecycleError>;
    readonly unarchive: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<Pick<OrchestrationV2ThreadProjection, "thread">, ThreadLifecycleError>;
    readonly delete: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<Pick<OrchestrationV2ThreadProjection, "thread">, ThreadLifecycleError>;
    readonly updateMetadata: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly title?: string;
      readonly branch?: string | null;
      readonly worktreePath?: string | null;
    }) => Effect.Effect<Pick<OrchestrationV2ThreadProjection, "thread">, ThreadLifecycleError>;
    readonly setRuntimeMode: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly runtimeMode: RuntimeMode;
    }) => Effect.Effect<Pick<OrchestrationV2ThreadProjection, "thread">, ThreadLifecycleError>;
    readonly setInteractionMode: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly interactionMode: ProviderInteractionMode;
    }) => Effect.Effect<Pick<OrchestrationV2ThreadProjection, "thread">, ThreadLifecycleError>;
    readonly setModelSelection: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly modelSelection: ModelSelection;
    }) => Effect.Effect<Pick<OrchestrationV2ThreadProjection, "thread">, ThreadLifecycleError>;
  }
>()("t3/orchestration-v2/ThreadLifecycleService") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;

  const dispatch = <Operation extends ThreadLifecycleError["operation"]>(
    operation: Operation,
    threadId: ThreadId,
    command: Parameters<ThreadManagement.ThreadManagementService["Service"]["dispatch"]>[0],
  ) =>
    threads.dispatch(command).pipe(
      Effect.andThen(threads.getThreadRecords(threadId, [])),
      Effect.mapError((cause) => new ThreadLifecycleError({ operation, threadId, cause })),
    );

  return ThreadLifecycleService.of({
    duplicate: (input) =>
      Effect.gen(function* () {
        if (input.sourceThreadId === input.targetThreadId)
          return yield* new ThreadDuplicateRejected({ reason: "same_thread" });
        // Replaying a successful request must never create a second copy.
        if (yield* threads.hasReceipt(input.commandId)) {
          const target = yield* threads.getThreadShell(input.targetThreadId);
          if (target === null)
            return yield* new ThreadDuplicateRejected({ reason: "previous_failed" });
          // Dispatch verifies that the receipt belongs to this target and command type.
          // Reconstruct the original command from the durable copy, not the source
          // which may have advanced or been removed since the first request.
          if (target.forkedFrom?.type === "run") {
            yield* threads.dispatch({
              type: "thread.fork",
              commandId: input.commandId,
              sourceThreadId: target.forkedFrom.threadId,
              targetThreadId: input.targetThreadId,
              sourcePoint: { type: "run", runId: target.forkedFrom.runId },
              title: target.title,
              createdBy: target.createdBy,
              creationSource: target.creationSource,
            });
          } else {
            yield* threads.dispatch({
              type: "thread.create",
              commandId: input.commandId,
              threadId: input.targetThreadId,
              projectId: target.projectId,
              title: target.title,
              modelSelection: target.modelSelection,
              runtimeMode: target.runtimeMode,
              interactionMode: target.interactionMode,
              branch: target.branch,
              worktreePath: target.worktreePath,
              createdBy: target.createdBy,
              creationSource: target.creationSource,
            });
          }
          return;
        }
        const original = yield* threads.getThreadRecords(input.sourceThreadId, [
          "runs",
          "contextTransfers",
        ]);
        if (original.thread.deletedAt !== null)
          return yield* new ThreadDuplicateRejected({ reason: "deleted" });
        const title = `${original.thread.title} copy`;
        let source = original;
        const visited = new Set<ThreadId>();
        for (;;) {
          if (visited.has(source.thread.id))
            return yield* new ThreadDuplicateRejected({ reason: "lineage_cycle" });
          visited.add(source.thread.id);
          const runs = source.runs.filter((run) => run.status !== "rolled_back");
          if (runs.some((run) => !isForkableSourceRunStatus(run.status)))
            return yield* new ThreadDuplicateRejected({ reason: "unfinished" });
          const latest = runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
          if (latest) {
            yield* threads.dispatch({
              type: "thread.fork",
              commandId: input.commandId,
              sourceThreadId: source.thread.id,
              targetThreadId: input.targetThreadId,
              sourcePoint: { type: "run", runId: latest.id },
              title,
              createdBy: input.creationSource === "mcp" ? "agent" : "user",
              creationSource: input.creationSource,
            });
            return;
          }
          const inherited = source.contextTransfers.find(
            (transfer) => transfer.type === "fork" && transfer.targetThreadId === source.thread.id,
          );
          if (inherited?.sourcePoint.runId) {
            yield* threads.dispatch({
              type: "thread.fork",
              commandId: input.commandId,
              sourceThreadId: inherited.sourceThreadId,
              targetThreadId: input.targetThreadId,
              sourcePoint: { type: "run", runId: inherited.sourcePoint.runId },
              title,
              createdBy: input.creationSource === "mcp" ? "agent" : "user",
              creationSource: input.creationSource,
            });
            return;
          }
          if (inherited) {
            source = yield* threads.getThreadRecords(inherited.sourceThreadId, [
              "runs",
              "contextTransfers",
            ]);
            continue;
          }
          const thread = original.thread;
          yield* threads.dispatch({
            type: "thread.create",
            commandId: input.commandId,
            threadId: input.targetThreadId,
            projectId: thread.projectId,
            title,
            modelSelection: thread.modelSelection,
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            branch: thread.branch,
            worktreePath: thread.worktreePath,
            createdBy: input.creationSource === "mcp" ? "agent" : "user",
            creationSource: input.creationSource,
          });
          return;
        }
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ThreadLifecycleError({
              operation: "duplicate",
              threadId: input.sourceThreadId,
              cause,
            }),
        ),
      ),
    archive: (input) =>
      dispatch("archive", input.threadId, {
        type: "thread.archive",
        commandId: input.commandId,
        threadId: input.threadId,
      }),
    unarchive: (input) =>
      dispatch("unarchive", input.threadId, {
        type: "thread.unarchive",
        commandId: input.commandId,
        threadId: input.threadId,
      }),
    delete: (input) =>
      dispatch("delete", input.threadId, {
        type: "thread.delete",
        commandId: input.commandId,
        threadId: input.threadId,
      }),
    updateMetadata: (input) =>
      dispatch("update-metadata", input.threadId, {
        type: "thread.metadata.update",
        commandId: input.commandId,
        threadId: input.threadId,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.branch === undefined ? {} : { branch: input.branch }),
        ...(input.worktreePath === undefined ? {} : { worktreePath: input.worktreePath }),
      }),
    setRuntimeMode: (input) =>
      dispatch("set-runtime-mode", input.threadId, {
        type: "thread.runtime-mode.set",
        commandId: input.commandId,
        threadId: input.threadId,
        runtimeMode: input.runtimeMode,
      }),
    setInteractionMode: (input) =>
      dispatch("set-interaction-mode", input.threadId, {
        type: "thread.interaction-mode.set",
        commandId: input.commandId,
        threadId: input.threadId,
        interactionMode: input.interactionMode,
      }),
    setModelSelection: (input) =>
      dispatch("set-model-selection", input.threadId, {
        type: "thread.model-selection.set",
        commandId: input.commandId,
        threadId: input.threadId,
        modelSelection: input.modelSelection,
      }),
  });
});

export const layer = Layer.effect(ThreadLifecycleService, make);
