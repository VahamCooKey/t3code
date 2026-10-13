import { assert, it } from "@effect/vitest";
import {
  ContextTransferId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderDriverKind,
  RunId,
  RunAttemptId,
  ProviderTurnId,
  NodeId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ThreadForkService from "./ThreadForkService.ts";

const sourceThreadId = ThreadId.make("thread:fork-snoozed-source");
const targetThreadId = ThreadId.make("thread:fork-awake-target");
const sourceRunId = RunId.make("run:fork-snoozed-source");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;
const sourceCreatedAt = DateTime.makeUnsafe("2026-07-24T09:00:00.000Z");
const snoozedAt = DateTime.makeUnsafe("2026-07-24T09:05:00.000Z");
const snoozedUntil = DateTime.makeUnsafe("2026-07-25T09:00:00.000Z");
const forkCreatedAt = DateTime.makeUnsafe("2026-07-24T09:10:00.000Z");

function makeSourceThread(): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: sourceThreadId,
    projectId: ProjectId.make("project:fork-snooze"),
    title: "Snoozed source",
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "plan",
    branch: "feature/source",
    worktreePath: "/tmp/source-worktree",
    activeProviderThreadId: ProviderThreadId.make("provider-thread:fork-snoozed-source"),
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: sourceThreadId,
    },
    forkedFrom: null,
    createdAt: sourceCreatedAt,
    updatedAt: snoozedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    snoozedUntil,
    snoozedAt,
    deletedAt: null,
  };
}

function makeSourceRun(status: OrchestrationV2Run["status"]): OrchestrationV2Run {
  return {
    id: sourceRunId,
    threadId: sourceThreadId,
    ordinal: 1,
    providerInstanceId,
    modelSelection,
    providerThreadId: ProviderThreadId.make("provider-thread:fork-snoozed-source"),
    userMessageId: MessageId.make("message:fork-snoozed-source"),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    queuePosition: null,
    requestedAt: sourceCreatedAt,
    startedAt: sourceCreatedAt,
    completedAt: snoozedAt,
    checkpointId: null,
    contextHandoffId: null,
  };
}

function makeSourceProjection(sourceRun: OrchestrationV2Run): OrchestrationV2ThreadProjection {
  return {
    thread: makeSourceThread(),
    runs: [sourceRun],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: snoozedAt,
  };
}

const planFork = (sourceRun: OrchestrationV2Run) =>
  Effect.gen(function* () {
    const service = yield* ThreadForkService.ThreadForkServiceV2;
    return yield* service.plan({
      sourceProjection: makeSourceProjection(sourceRun),
      sourceRun,
      sourceProviderThread: undefined,
      canonicalSourcePoint: {
        threadId: sourceThreadId,
        runId: sourceRunId,
      },
      transferId: ContextTransferId.make("context-transfer:fork-snoozed-source"),
      targetThreadId,
      title: "Awake fork",
      createdBy: "user",
      creationSource: "mobile",
      createdAt: forkCreatedAt,
    });
  }).pipe(Effect.provide(ThreadForkService.layer));

it("treats usage-limited and other provider-finished runs as forkable", () => {
  assert.isTrue(ThreadForkService.isForkableSourceRunStatus("completed"));
  assert.isTrue(ThreadForkService.isForkableSourceRunStatus("waiting"));
  assert.isTrue(ThreadForkService.isForkableSourceRunStatus("failed"));
  assert.isTrue(ThreadForkService.isForkableSourceRunStatus("interrupted"));
  assert.isTrue(ThreadForkService.isForkableSourceRunStatus("cancelled"));
  assert.isFalse(ThreadForkService.isForkableSourceRunStatus("running"));
  assert.isFalse(ThreadForkService.isForkableSourceRunStatus("starting"));
  assert.isFalse(ThreadForkService.isForkableSourceRunStatus("queued"));
  assert.isFalse(ThreadForkService.isForkableSourceRunStatus("preparing"));
  assert.isFalse(ThreadForkService.isForkableSourceRunStatus("rolled_back"));
});

it.effect("keeps a fork awake when its source thread is snoozed", () =>
  Effect.gen(function* () {
    const sourceThread = makeSourceThread();
    const sourceRun = makeSourceRun("completed");
    const result = yield* planFork(sourceRun);

    assert.isNull(result.targetThread.snoozedUntil);
    assert.isNull(result.targetThread.snoozedAt);
    assert.equal(result.targetThread.projectId, sourceThread.projectId);
    assert.equal(result.targetThread.providerInstanceId, sourceThread.providerInstanceId);
    assert.deepEqual(result.targetThread.modelSelection, sourceThread.modelSelection);
    assert.equal(result.targetThread.runtimeMode, sourceThread.runtimeMode);
    assert.equal(result.targetThread.interactionMode, sourceThread.interactionMode);
    assert.equal(result.targetThread.branch, sourceThread.branch);
    assert.equal(result.targetThread.worktreePath, sourceThread.worktreePath);
    assert.isNull(result.targetThread.activeProviderThreadId);
    assert.deepEqual(result.targetThread.lineage, {
      parentThreadId: sourceThreadId,
      relationshipToParent: "fork",
      rootThreadId: sourceThreadId,
    });
    assert.deepEqual(result.targetThread.forkedFrom, {
      type: "run",
      threadId: sourceThreadId,
      runId: sourceRunId,
    });
  }),
);

it.effect("forks from a usage-limited failed run", () =>
  Effect.gen(function* () {
    const result = yield* planFork(makeSourceRun("failed"));
    assert.deepEqual(result.targetThread.forkedFrom, {
      type: "run",
      threadId: sourceThreadId,
      runId: sourceRunId,
    });
  }),
);

it.effect("rejects in-progress and rolled-back fork sources", () =>
  Effect.gen(function* () {
    for (const status of ["running", "rolled_back"] as const) {
      const sourceRun = makeSourceRun(status);
      const error = yield* planFork(sourceRun).pipe(Effect.flip);
      assert.equal(error._tag, "ThreadForkPlanError");
      assert.equal(error.sourceThreadId, sourceThreadId);
      assert.equal(error.targetThreadId, targetThreadId);
      assert.equal(error.cause, ThreadForkService.forkableSourceRunStatusError(sourceRun));
    }
  }),
);

function makeNativeSource() {
  const sourceRun = {
    ...makeSourceRun("interrupted"),
    activeAttemptId: RunAttemptId.make("attempt:source"),
  };
  const projection = makeSourceProjection(sourceRun);
  const providerThread = {
    id: sourceRun.providerThreadId!,
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId,
    providerSessionId: null,
    appThreadId: sourceThreadId,
    ownerNodeId: null,
    nativeThreadRef: {
      driver: ProviderDriverKind.make("codex"),
      nativeId: "native:source",
      strength: "strong" as const,
    },
    nativeConversationHeadRef: null,
    status: "idle" as const,
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    createdAt: sourceCreatedAt,
    updatedAt: snoozedAt,
  };
  const attempt = {
    id: sourceRun.activeAttemptId,
    runId: sourceRun.id,
    attemptOrdinal: 1,
    rootNodeId: NodeId.make("node:source"),
    providerInstanceId,
    providerThreadId: providerThread.id,
    providerTurnId: ProviderTurnId.make("turn:source"),
    nativeThreadId: "native:source",
    reason: "initial" as const,
    status: "interrupted" as const,
    startedAt: sourceCreatedAt,
    completedAt: snoozedAt,
  };
  const turn = {
    id: attempt.providerTurnId,
    providerThreadId: providerThread.id,
    nodeId: attempt.rootNodeId,
    runAttemptId: attempt.id,
    nativeTurnRef: {
      driver: ProviderDriverKind.make("codex"),
      nativeId: "native:turn",
      strength: "strong" as const,
    },
    ordinal: 1,
    status: "interrupted" as const,
    startedAt: sourceCreatedAt,
    completedAt: snoozedAt,
  };
  return {
    sourceRun,
    providerThread,
    attempt,
    turn,
    projection: {
      ...projection,
      attempts: [attempt],
      providerTurns: [turn],
      providerThreads: [providerThread],
    },
  };
}

it("resolves cancelled queue entries to the last native turn by run and provider-turn ordinal", () => {
  const { sourceRun, projection, turn, attempt } = makeNativeSource();
  const cancelled = {
    ...sourceRun,
    id: RunId.make("run:queued"),
    ordinal: 4,
    status: "cancelled" as const,
    startedAt: null,
    activeAttemptId: null,
  };
  const rolledBack = {
    ...sourceRun,
    id: RunId.make("run:rolled-back"),
    ordinal: 3,
    status: "rolled_back" as const,
    activeAttemptId: RunAttemptId.make("attempt:rolled-back"),
  };
  const latest = { ...turn, id: ProviderTurnId.make("turn:last"), ordinal: 2 };
  const history = {
    ...projection,
    runs: [cancelled, rolledBack, sourceRun],
    attempts: [attempt, { ...attempt, id: rolledBack.activeAttemptId, runId: rolledBack.id }],
    providerTurns: [
      {
        ...turn,
        id: ProviderTurnId.make("turn:rolled-back"),
        ordinal: 3,
        runAttemptId: rolledBack.activeAttemptId,
      },
      latest,
      turn,
    ],
  };
  assert.equal(ThreadForkService.forkSourceProviderTurn(history, cancelled)?.id, latest.id);
  assert.deepEqual(
    ThreadForkService.forkSourceProviderTurns(history).map((candidate) => candidate.id),
    [latest.id, turn.id],
  );
});

it("rejects head-only forks after native history advances, but ignores queued and rolled-back suffixes", () => {
  const { sourceRun, projection, providerThread, turn } = makeNativeSource();
  const source = { ...projection, providerTurns: [{ ...turn, nativeTurnRef: null }] };
  const later = { ...sourceRun, id: RunId.make("run:later"), ordinal: 2, activeAttemptId: null };
  assert.isTrue(ThreadForkService.forkSourceHasNativeBoundary(source, sourceRun, providerThread));
  assert.isFalse(
    ThreadForkService.forkSourceHasNativeBoundary(
      { ...source, runs: [sourceRun, later] },
      sourceRun,
      providerThread,
    ),
  );
  for (const suffix of [
    { ...later, status: "rolled_back" as const },
    { ...later, status: "queued" as const, startedAt: null },
  ]) {
    assert.isTrue(
      ThreadForkService.forkSourceHasNativeBoundary(
        { ...source, runs: [suffix, sourceRun] },
        sourceRun,
        providerThread,
      ),
    );
  }
  assert.isTrue(
    ThreadForkService.forkSourceHasNativeBoundary(
      { ...projection, runs: [later, sourceRun] },
      sourceRun,
      providerThread,
    ),
  );
});

it("rejects a cursorless head when the provider thread was rebound to a different native session", () => {
  const { sourceRun, projection, providerThread, turn } = makeNativeSource();
  for (const providerTurns of [[{ ...turn, nativeTurnRef: null }], []]) {
    assert.isFalse(
      ThreadForkService.forkSourceHasNativeBoundary({ ...projection, providerTurns }, sourceRun, {
        ...providerThread,
        nativeThreadRef: { ...providerThread.nativeThreadRef, nativeId: "native:replacement" },
      }),
    );
  }
});

it("rejects cursorless head forks of cancelled queue entries while earlier native history is active", () => {
  const { sourceRun, projection, providerThread, turn } = makeNativeSource();
  const cancelled = {
    ...sourceRun,
    id: RunId.make("run:cancelled-queue"),
    ordinal: 2,
    status: "cancelled" as const,
    startedAt: null,
    activeAttemptId: null,
  };
  for (const status of ["running", "pending"] as const) {
    const history = {
      ...projection,
      runs: [cancelled, { ...sourceRun, status: "running" as const }],
      providerTurns: [{ ...turn, status, completedAt: null }],
    };
    assert.isUndefined(ThreadForkService.forkSourceProviderTurn(history, cancelled));
    assert.isFalse(
      ThreadForkService.forkSourceHasNativeBoundary(history, cancelled, providerThread),
    );
    // A native start may be in flight before the provider turn is projected.
    assert.isFalse(
      ThreadForkService.forkSourceHasNativeBoundary(
        { ...history, providerTurns: [] },
        cancelled,
        providerThread,
      ),
    );
    // A stale run status must not hide an active native turn either.
    assert.isFalse(
      ThreadForkService.forkSourceHasNativeBoundary(
        {
          ...history,
          runs: [cancelled, sourceRun],
          providerTurns: [{ ...turn, status, nativeTurnRef: null }],
        },
        cancelled,
        providerThread,
      ),
    );
    // Other provider threads do not mutate this native head.
    assert.isTrue(
      ThreadForkService.forkSourceHasNativeBoundary(
        {
          ...history,
          runs: [cancelled],
          providerTurns: [
            { ...turn, status, providerThreadId: ProviderThreadId.make("other-provider-thread") },
          ],
        },
        cancelled,
        providerThread,
      ),
    );
  }
});
