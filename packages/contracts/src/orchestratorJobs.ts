import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const OrchestratorJobsInput = Schema.Struct({
  cwds: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(50)),
});
export type OrchestratorJobsInput = typeof OrchestratorJobsInput.Type;

export const OrchestratorJobCategory = Schema.Literals([
  "running",
  "review",
  "failed",
  "completed",
]);
export const OrchestratorJob = Schema.Struct({
  id: Schema.String,
  cwd: Schema.String,
  statePath: Schema.String,
  category: OrchestratorJobCategory,
  phase: Schema.String,
  model: Schema.String,
  task: Schema.String,
  updatedAt: Schema.String,
  branch: Schema.String,
  worktree: Schema.String,
});
export type OrchestratorJob = typeof OrchestratorJob.Type;
export const OrchestratorJobsResult = Schema.Struct({
  jobs: Schema.Array(OrchestratorJob),
  skippedFiles: Schema.Number,
  truncated: Schema.Boolean,
  discoveryWarning: Schema.optional(Schema.String),
});
export type OrchestratorJobsResult = typeof OrchestratorJobsResult.Type;

export class OrchestratorJobsError extends Schema.TaggedError<OrchestratorJobsError>()(
  "OrchestratorJobsError",
  { cwd: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not read orchestrator jobs in '${this.cwd}'.`;
  }
}
