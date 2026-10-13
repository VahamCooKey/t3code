import {
  ContextTransferId,
  latestProviderTurnForAttempt,
  OrchestrationV2Actor,
  OrchestrationV2AppThread,
  OrchestrationV2ContextSourcePoint,
  OrchestrationV2ContextTransfer,
  OrchestrationV2CreationSource,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export interface ThreadForkPlanV2 {
  readonly targetThread: OrchestrationV2AppThread;
  readonly transfer: OrchestrationV2ContextTransfer;
}

export class ThreadForkPlanError extends Schema.TaggedError<ThreadForkPlanError>()(
  "ThreadForkPlanError",
  {
    sourceThreadId: ThreadId,
    targetThreadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * Fork copies a provider-finished conversation. Usage-limited and other
 * failed, interrupted, or cancelled turns still have a native thread (or a
 * portable transcript) even though the run did not complete successfully.
 * `waiting` is provider-finished with checkpoint capture still pending.
 * In-progress and rolled-back runs are not forkable.
 */
export function isForkableSourceRunStatus(status: OrchestrationV2Run["status"]): boolean {
  return (
    status === "completed" ||
    status === "waiting" ||
    status === "failed" ||
    status === "interrupted" ||
    status === "cancelled"
  );
}

export function forkableSourceRunStatusError(
  run: Pick<OrchestrationV2Run, "id" | "status">,
): string {
  return `Fork source run ${run.id} is ${run.status}; in-progress and rolled-back runs cannot be forked.`;
}

/** Exclude audit turns that a rewind already removed from native history. */
export function forkSourceProviderTurns(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "attempts" | "providerTurns">,
) {
  const rolledBackRuns = new Set(
    projection.runs.filter((run) => run.status === "rolled_back").map((run) => run.id),
  );
  const rolledBackAttempts = new Set(
    projection.attempts
      .filter((attempt) => rolledBackRuns.has(attempt.runId))
      .map((attempt) => attempt.id),
  );
  return projection.providerTurns.filter(
    (turn) => turn.runAttemptId === null || !rolledBackAttempts.has(turn.runAttemptId),
  );
}

/** Resolve the native boundary, including queued runs cancelled before delivery. */
export function forkSourceProviderTurn(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "attempts" | "providerTurns">,
  sourceRun: OrchestrationV2Run,
) {
  const providerTurns = forkSourceProviderTurns(projection);
  const candidates =
    sourceRun.startedAt === null
      ? projection.runs
          .filter(
            (run) =>
              run.ordinal <= sourceRun.ordinal &&
              run.providerThreadId === sourceRun.providerThreadId &&
              isForkableSourceRunStatus(run.status),
          )
          .toSorted((left, right) => right.ordinal - left.ordinal)
      : [sourceRun];
  for (const run of candidates) {
    const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
    const turn =
      latestProviderTurnForAttempt(providerTurns, attempt?.id) ??
      providerTurns.find((candidate) => candidate.id === attempt?.providerTurnId);
    if (turn?.providerThreadId === sourceRun.providerThreadId) return turn;
  }
  return undefined;
}

/** A cursor bounds a historical fork; otherwise only an unchanged native head is safe. */
export function forkSourceHasNativeBoundary(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "attempts" | "providerTurns">,
  sourceRun: OrchestrationV2Run,
  providerThread: OrchestrationV2ProviderThread,
) {
  if (!isForkableSourceRunStatus(sourceRun.status)) return false;
  const turn = forkSourceProviderTurn(projection, sourceRun);
  const cursor = turn?.nativeTurnRef;
  if (
    cursor?.nativeId &&
    cursor.driver === providerThread.driver &&
    !(cursor.driver === "claudeAgent" && cursor.nativeId.startsWith("turn:"))
  )
    return true;
  const attempt = projection.attempts.find(
    (candidate) => candidate.id === (turn?.runAttemptId ?? sourceRun.activeAttemptId),
  );
  if (
    attempt?.nativeThreadId !== undefined &&
    attempt.nativeThreadId !== providerThread.nativeThreadRef?.nativeId
  )
    return false;
  return forkSourceIsNativeHead(projection, sourceRun);
}

/** A head-only fork requires settled native history that has not advanced past the cutoff. */
function forkSourceIsNativeHead(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "attempts" | "providerTurns">,
  sourceRun: OrchestrationV2Run,
) {
  const providerTurns = forkSourceProviderTurns(projection);
  if (
    providerTurns.some(
      (turn) =>
        turn.providerThreadId === sourceRun.providerThreadId &&
        (turn.status === "running" || turn.status === "pending"),
    )
  )
    return false;
  return !projection.runs.some(
    (run) =>
      run.providerThreadId === sourceRun.providerThreadId &&
      run.status !== "rolled_back" &&
      (run.ordinal > sourceRun.ordinal || !isForkableSourceRunStatus(run.status)) &&
      (run.startedAt !== null ||
        projection.attempts.some(
          (attempt) =>
            attempt.runId === run.id &&
            providerTurns.some((turn) => turn.runAttemptId === attempt.id),
        )),
  );
}

export interface ThreadForkServiceV2Shape {
  readonly plan: (input: {
    readonly sourceProjection: Pick<OrchestrationV2ThreadProjection, "thread">;
    readonly sourceRun: OrchestrationV2Run;
    readonly sourceProviderThread: OrchestrationV2ProviderThread | undefined;
    readonly canonicalSourcePoint: OrchestrationV2ContextSourcePoint;
    readonly transferId: ContextTransferId;
    readonly targetThreadId: ThreadId;
    readonly title?: string;
    readonly createdBy: OrchestrationV2Actor;
    readonly creationSource: OrchestrationV2CreationSource;
    readonly createdAt: DateTime.Utc;
  }) => Effect.Effect<ThreadForkPlanV2, ThreadForkPlanError>;
}

export class ThreadForkServiceV2 extends Context.Service<
  ThreadForkServiceV2,
  ThreadForkServiceV2Shape
>()("t3/orchestration-v2/ThreadForkService/ThreadForkServiceV2") {}

export const layer: Layer.Layer<ThreadForkServiceV2> = Layer.succeed(
  ThreadForkServiceV2,
  ThreadForkServiceV2.of({
    plan: (input) =>
      Effect.gen(function* () {
        if (!isForkableSourceRunStatus(input.sourceRun.status)) {
          return yield* new ThreadForkPlanError({
            sourceThreadId: input.sourceProjection.thread.id,
            targetThreadId: input.targetThreadId,
            cause: forkableSourceRunStatusError(input.sourceRun),
          });
        }
        const targetThread: OrchestrationV2AppThread = {
          ...input.sourceProjection.thread,
          createdBy: input.createdBy,
          creationSource: input.creationSource,
          id: input.targetThreadId,
          title: input.title ?? `${input.sourceProjection.thread.title} fork`,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: input.sourceProjection.thread.id,
            relationshipToParent: "fork",
            rootThreadId: input.sourceProjection.thread.lineage.rootThreadId,
          },
          forkedFrom: {
            type: "run",
            threadId: input.sourceProjection.thread.id,
            runId: input.sourceRun.id,
          },
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          snoozedUntil: null,
          snoozedAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        };
        const transfer: OrchestrationV2ContextTransfer = {
          id: input.transferId,
          type: "fork",
          sourceThreadId: input.sourceProjection.thread.id,
          targetThreadId: input.targetThreadId,
          sourcePoint: input.canonicalSourcePoint,
          basePoint: null,
          sourceProviderInstanceId: input.sourceRun.providerInstanceId,
          targetProviderInstanceId: null,
          targetRunId: null,
          status: "pending",
          resolution: null,
          createdBy: input.createdBy,
          error:
            input.sourceProviderThread?.nativeThreadRef?.strength === "strong"
              ? null
              : "Source provider thread does not expose a strong native thread ref.",
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
          consumedAt: null,
        };
        return { targetThread, transfer };
      }),
  }),
);
