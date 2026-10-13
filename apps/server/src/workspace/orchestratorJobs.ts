import type { OrchestratorJob, OrchestratorJobsResult } from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const STATE_DIRECTORY = "output/orchestration/chain-state";
const MAX_BYTES = 1024 * 1024;
const decodeState = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const ACTIVE_PHASES = new Set([
  "initialized",
  "coder_launching",
  "coder_running",
  "checks_running",
  "reviewer_launching",
  "reviewer_running",
  "review_validating",
]);
const COMPLETED_PHASES = new Set([
  "accepted",
  "complete",
  "completed",
  "finished",
  "success",
  "succeeded",
]);
const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown, limit = 256) =>
  typeof value === "string" ? value.slice(0, limit) : "";
const contained = (path: Path.Path, root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const stoppedWorker = (pid: unknown) => {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return object(error).code === "ESRCH";
  }
};

// Only summaries cross the wire: prompts, logs, tokens and worker receipts stay on disk.
export const readOrchestratorJobs = Effect.fn("readOrchestratorJobs")(function* (
  cwds: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const jobs: OrchestratorJob[] = [];
  let skippedFiles = 0;
  const candidates: {
    cwd: string;
    root: string;
    directory: string;
    name: string;
    modified: number;
  }[] = [];
  for (const cwd of new Set(cwds)) {
    const directory = path.join(cwd, STATE_DIRECTORY);
    const listing = yield* Effect.gen(function* () {
      const root = yield* fs.realPath(cwd);
      const realDirectory = yield* fs.realPath(directory);
      if (!contained(path, root, realDirectory)) return null;
      return { root, files: yield* fs.readDirectory(directory) };
    }).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed({ root: cwd, files: [] }),
      ),
    );
    if (!listing) {
      skippedFiles++;
      continue;
    }
    const datedFiles = yield* Effect.forEach(
      listing.files.filter((name) => name.endsWith(".json")),
      (name) =>
        fs.stat(path.join(directory, name)).pipe(
          Effect.map((stat) => ({
            name,
            modified: Option.getOrElse(
              Option.map(stat.mtime, (date) => date.getTime()),
              () => 0,
            ),
          })),
          Effect.orElseSucceed(() => ({ name, modified: 0 })),
        ),
      { concurrency: 8 },
    );
    candidates.push(...datedFiles.map((file) => ({ ...file, cwd, root: listing.root, directory })));
  }
  candidates.sort((a, b) => b.modified - a.modified);
  for (const file of candidates) {
    const { cwd, root, directory } = file;
    const statePath = `${STATE_DIRECTORY}/${file.name}`;
    const job = yield* Effect.gen(function* () {
      const filePath = yield* fs.realPath(path.join(directory, file.name));
      if (!contained(path, root, filePath)) return null;
      const info = yield* fs.stat(filePath);
      if (info.type !== "File" || ByteSize.toBigInt(info.size) > BigInt(MAX_BYTES)) return null;
      const handle = yield* fs.open(filePath, { flag: "r" });
      const stat = yield* handle.stat;
      if (stat.type !== "File" || ByteSize.toBigInt(stat.size) > BigInt(MAX_BYTES)) return null;
      const buffer = new Uint8Array(ByteSize.toNumberUnsafe(stat.size));
      const bytesRead = yield* handle.read(buffer);
      const state = object(
        yield* decodeState(new TextDecoder().decode(buffer.subarray(0, bytesRead))),
      );
      if (state.chainState !== true || !text(state.chainId)) return null;
      const phase = text(state.phase) || "unknown_phase";
      const worker = object(phase.startsWith("review") ? state.reviewer : state.coder);
      const workerStopped =
        (phase === "coder_running" || phase === "reviewer_running") && stoppedWorker(worker.pid);
      const worktree = object(state.worktree);
      const recordedDate = text(state.updatedAt);
      return {
        id: text(state.chainId),
        cwd,
        statePath,
        phase,
        category:
          phase === "ready_for_supervisor"
            ? "review"
            : COMPLETED_PHASES.has(phase)
              ? "completed"
              : ACTIVE_PHASES.has(phase) && !workerStopped
                ? "running"
                : "failed",
        model: text(worker.modelInUse || worker.model),
        task: text(state.task, 512).split(/\r?\n/, 1)[0] ?? "",
        updatedAt: Number.isFinite(Date.parse(recordedDate))
          ? recordedDate
          : Option.getOrElse(
              Option.map(stat.mtime, (date) => date.toISOString()),
              () => "1970-01-01T00:00:00.000Z",
            ),
        branch: text(worktree.branch),
        worktree: text(worktree.path),
      } satisfies OrchestratorJob;
    }).pipe(
      Effect.scoped,
      Effect.orElseSucceed(() => null),
    );
    // A runner can be replacing a file; skip invalid/incomplete state this refresh.
    if (job) jobs.push(job);
    else skippedFiles++;
  }
  jobs.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const counts = new Map<string, number>();
  const visibleJobs = jobs.filter((job) => {
    if (job.category === "running") return true;
    const count = (counts.get(job.category) ?? 0) + 1;
    counts.set(job.category, count);
    return count <= 5;
  });
  return { jobs: visibleJobs, skippedFiles, truncated: false } satisfies OrchestratorJobsResult;
});
