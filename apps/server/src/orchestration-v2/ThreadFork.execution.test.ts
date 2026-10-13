import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const forkCases = (["codex", "claudeAgent"] as const).flatMap((driverName) => {
  const driver = ProviderDriverKind.make(driverName);
  const instanceId = ProviderInstanceId.make(driver);
  const modelSelection = { instanceId, model: "test-model" };
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () =>
      Effect.succeed(
        driver === "codex" ? CodexProviderCapabilitiesV2 : ClaudeProviderCapabilitiesV2,
      ),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("Execution is paused after dispatch for handoff inspection"),
  };
  const targetInstanceId = ProviderInstanceId.make(`${driver}-other-account`);
  const targetAdapter = { ...adapter, instanceId: targetInstanceId };
  const layer = ProviderReplayHarness.layerWithRegistry(
    { name: `fork-boundary-${driver}` },
    ProviderAdapterRegistry.layerFromAdapters([adapter, targetAdapter]),
    { runEffectWorker: false },
  );

  return (["failed", "interrupted", "cancelled"] as const).flatMap((status) =>
    (["native", "portable", "missing", "active"] as const)
      .filter((mode) => mode !== "active" || status === "cancelled")
      .map((mode) => ({
        driver,
        status,
        instanceId,
        modelSelection,
        layer,
        mode,
        targetModelSelection:
          mode === "portable"
            ? { ...modelSelection, instanceId: targetInstanceId }
            : modelSelection,
      })),
  );
});

it.effect.each(forkCases)(
  "honors $mode history for $driver forks of a $status run",
  ({ driver, status, instanceId, modelSelection, targetModelSelection, layer, mode }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const sourceThreadId = ThreadId.make("fork-boundary-source");
      const targetThreadId = ThreadId.make("fork-boundary-target");
      const providerThreadId = ProviderThreadId.make("fork-boundary-native-thread");
      const sourceRunId = RunId.make("fork-boundary-source-run");
      const attemptId = RunAttemptId.make("interrupted-source-attempt");
      const providerTurnId = ProviderTurnId.make("interrupted-source-turn");
      const rootNodeId = NodeId.make("interrupted-source-root");

      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-source"),
        threadId: sourceThreadId,
        projectId: ProjectId.make("fork-boundary-project"),
        title: "Fork boundary source",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("source-provider-thread"),
            type: "provider-thread.updated",
            threadId: sourceThreadId,
            occurredAt: now,
            payload: {
              id: providerThreadId,
              driver,
              providerInstanceId: instanceId,
              providerSessionId: null,
              appThreadId: sourceThreadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-source", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 1,
              lastRunOrdinal: 2,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
        ],
      });
      // Cancelled queued input inherits the prior native boundary.
      const boundaryRunId = status === "cancelled" ? RunId.make("previous-run") : sourceRunId;
      if (mode === "native" || mode === "active") {
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("source-attempt"),
              type: "run-attempt.created",
              threadId: sourceThreadId,
              runId: boundaryRunId,
              occurredAt: now,
              payload: {
                id: attemptId,
                runId: boundaryRunId,
                attemptOrdinal: 1,
                rootNodeId,
                providerInstanceId: instanceId,
                providerThreadId,
                providerTurnId,
                reason: "initial",
                status: mode === "active" ? "running" : status,
                startedAt: now,
                completedAt: mode === "active" ? null : now,
              },
            },
            {
              id: EventId.make("source-provider-turn"),
              type: "provider-turn.updated",
              threadId: sourceThreadId,
              occurredAt: now,
              payload: {
                id: providerTurnId,
                providerThreadId,
                nodeId: rootNodeId,
                runAttemptId: attemptId,
                nativeTurnRef: { driver, nativeId: "native-source-cursor", strength: "strong" },
                ordinal: 1,
                status: mode === "active" ? "running" : status,
                startedAt: now,
                completedAt: mode === "active" ? null : now,
              },
            },
          ],
        });
      }
      for (const ordinal of mode === "active" ? [1, 2] : [1, 2, 3]) {
        const runId =
          ordinal === 2
            ? sourceRunId
            : ordinal === 1
              ? RunId.make("previous-run")
              : RunId.make("later-run");
        const messageId = MessageId.make(`source-message-${ordinal}`);
        yield* eventSink.write({
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
                activeAttemptId:
                  (mode === "native" || mode === "active") && runId === boundaryRunId
                    ? attemptId
                    : null,
                status: ordinal === 2 ? status : mode === "active" ? "running" : "completed",
                queuePosition: null,
                requestedAt: now,
                startedAt: ordinal === 2 && status === "cancelled" ? null : now,
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
                text: ordinal <= 2 ? "INCLUDED_SOURCE_MARKER" : "EXCLUDED_LATER_MARKER",
                attachments: [],
              },
            },
          ],
        });
      }
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("fork-source"),
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "run", runId: sourceRunId },
        createdBy: "user",
        creationSource: "web",
      });
      const continuation = orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("continue-fork"),
        threadId: targetThreadId,
        messageId: MessageId.make("continue-fork"),
        text: "Continue from the selected source run",
        attachments: [],
        modelSelection: targetModelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      if (mode === "missing" || mode === "active") {
        const error = yield* continuation.pipe(Effect.flip);
        assert.instanceOf(error, Orchestrator.OrchestratorDispatchError);
        const target = yield* orchestrator.getThreadProjection(targetThreadId);
        assert.include(String(error.cause), "native_fork_boundary");
        assert.lengthOf(target.runs, 0);
        assert.lengthOf(target.providerThreads, 0);
        assert.lengthOf(target.contextHandoffs, 0);
        return;
      }
      yield* continuation;
      const target = yield* orchestrator.getThreadProjection(targetThreadId);
      if (mode === "native") {
        assert.lengthOf(target.contextHandoffs, 0);
        assert.isNull(target.contextTransfers[0]?.resolution);
        assert.deepEqual(target.providerThreads[0]?.forkedFrom, {
          providerThreadId,
          providerTurnId,
        });
        return;
      }
      assert.equal(target.contextTransfers[0]?.resolution?.strategy, "portable_context");
      assert.lengthOf(target.contextHandoffs, 1);
      const handoff = target.contextHandoffs[0]!;
      const history = handoff.history?.messages.map((message) => message.text).join("\n") ?? "";
      assert.include(`${handoff.summaryText}\n${history}`, "INCLUDED_SOURCE_MARKER");
      assert.notInclude(`${handoff.summaryText}\n${history}`, "EXCLUDED_LATER_MARKER");
      assert.isNull(target.providerThreads[0]?.forkedFrom);
    }).pipe(Effect.provide(layer)),
);
