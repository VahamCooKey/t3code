import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderDriverKind,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceipts from "./CommandReceiptStore.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapters from "./ProviderAdapterRegistry.ts";
import * as ThreadLifecycle from "./ThreadLifecycleService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as Harness from "./testkit/ProviderReplayHarness.ts";
import * as Sqlite from "../persistence/Sqlite.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const sourceThreadId = ThreadId.make("source");
const targetThreadId = ThreadId.make("copy");
const providerThreadId = ProviderThreadId.make("source-provider-thread");
const duplicateInput = {
  commandId: CommandId.make("copy"),
  sourceThreadId,
  targetThreadId,
  creationSource: "web" as const,
};
const runtime = Harness.layerWithRegistry(
  { name: "duplicate" },
  ProviderAdapters.layerFromAdapters([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("Worker is paused for inspection"),
    },
  ]),
  { runEffectWorker: false },
);

// The application service calls the real orchestrator and persistent receipts.
const layer = Layer.unwrap(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const receipts = yield* CommandReceipts.CommandReceiptStoreV2;
    return ThreadLifecycle.layer.pipe(
      Layer.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          dispatch: orchestrator.dispatch,
          getThreadRecords: orchestrator.getThreadRecords,
          getThreadShell: orchestrator.getThreadShell,
          hasReceipt: (id) =>
            receipts.getByCommandId(id).pipe(
              Effect.map(Option.isSome),
              Effect.orElseSucceed(() => false),
            ),
        }),
      ),
    );
  }),
).pipe(
  Layer.provideMerge(
    Layer.merge(runtime, CommandReceipts.layer.pipe(Layer.provide(Sqlite.layerMemory))),
  ),
);

const createSource = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("source"),
    threadId: sourceThreadId,
    projectId: ProjectId.make("project"),
    title: "Source",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature/source",
    worktreePath: "/source",
    createdBy: "user",
    creationSource: "web",
  });
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  yield* sink.write({
    events: [
      {
        id: EventId.make("source-provider-thread"),
        type: "provider-thread.updated",
        threadId: sourceThreadId,
        occurredAt: now,
        payload: {
          id: providerThreadId,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: instanceId,
          providerSessionId: null,
          appThreadId: sourceThreadId,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: 1,
          lastRunOrdinal: 3,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      },
    ],
  });
});

const addRun = (ordinal: number, status: OrchestrationV2Run["status"] = "completed") =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const runId = RunId.make(`run-${ordinal}`);
    const messageId = MessageId.make(`message-${ordinal}`);
    yield* sink.write({
      events: [
        {
          id: EventId.make(`run-${ordinal}`),
          type: "run.created",
          threadId: sourceThreadId,
          runId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId: sourceThreadId,
            ordinal,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: messageId,
            rootNodeId: null,
            activeAttemptId: null,
            status,
            queuePosition: null,
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
        {
          id: EventId.make(`item-${ordinal}`),
          type: "turn-item.updated",
          threadId: sourceThreadId,
          runId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`item-${ordinal}`),
            threadId: sourceThreadId,
            runId,
            nodeId: null,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "user_message",
            createdBy: "user",
            creationSource: "web",
            inputIntent: "turn_start",
            messageId,
            text: `HISTORY_MARKER_${ordinal}`,
            attachments: [],
          },
        },
      ],
    });
  });

it.effect(
  "copies the full conversation and keeps a second copy bounded when the source advances",
  () =>
    Effect.gen(function* () {
      const lifecycle = yield* ThreadLifecycle.ThreadLifecycleService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* createSource;
      yield* addRun(1);
      yield* addRun(2);
      yield* lifecycle.duplicate(duplicateInput);
      const copy = yield* orchestrator.getThreadProjection(targetThreadId);
      assert.equal(copy.thread.title, "Source copy");
      assert.equal(copy.contextTransfers[0]?.sourcePoint.runId, RunId.make("run-2"));
      assert.equal(copy.thread.branch, "feature/source");
      assert.isNull(copy.thread.activeProviderThreadId);
      yield* addRun(3);
      yield* lifecycle.duplicate(duplicateInput);
      assert.lengthOf(
        (yield* orchestrator.getThreadProjection(targetThreadId)).contextTransfers,
        1,
      );
      const secondCopyId = ThreadId.make("second-copy");
      yield* lifecycle.duplicate({
        ...duplicateInput,
        commandId: CommandId.make("second-copy"),
        sourceThreadId: targetThreadId,
        targetThreadId: secondCopyId,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("continue"),
        threadId: secondCopyId,
        messageId: MessageId.make("continue"),
        text: "Continue",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const continued = yield* orchestrator.getThreadProjection(secondCopyId);
      const handoff = continued.contextHandoffs[0]!;
      const history = `${handoff.summaryText}\n${handoff.history?.messages.map((message) => message.text).join("\n") ?? ""}`;
      assert.include(history, "HISTORY_MARKER_1");
      assert.include(history, "HISTORY_MARKER_2");
      assert.notInclude(history, "HISTORY_MARKER_3");
      assert.lengthOf((yield* orchestrator.getThreadProjection(sourceThreadId)).runs, 3);
    }).pipe(Effect.provide(layer)),
);

it.effect("duplicates an empty session with its settings and no provider process", () =>
  Effect.gen(function* () {
    const lifecycle = yield* ThreadLifecycle.ThreadLifecycleService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* createSource;
    yield* lifecycle.duplicate(duplicateInput);
    yield* addRun(1);
    yield* lifecycle.duplicate(duplicateInput);
    const copy = yield* orchestrator.getThreadProjection(targetThreadId);
    assert.equal(copy.thread.title, "Source copy");
    assert.deepEqual(copy.thread.modelSelection, modelSelection);
    assert.equal(copy.thread.worktreePath, "/source");
    assert.lengthOf(copy.runs, 0);
    assert.lengthOf(copy.providerSessions, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect.each(["running", "queued"] as const)(
  "refuses a $status session without truncating it",
  (status) =>
    Effect.gen(function* () {
      const lifecycle = yield* ThreadLifecycle.ThreadLifecycleService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* createSource;
      yield* addRun(1);
      yield* addRun(2, status);
      const error = yield* Effect.flip(lifecycle.duplicate(duplicateInput));
      assert.equal(error._tag, "ThreadLifecycleError");
      assert.isNull(yield* orchestrator.getThreadShell(targetThreadId));
      assert.lengthOf((yield* orchestrator.getThreadProjection(sourceThreadId)).runs, 2);
    }).pipe(Effect.provide(layer)),
);
