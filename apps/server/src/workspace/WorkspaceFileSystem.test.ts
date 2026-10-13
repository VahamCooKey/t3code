// @effect-diagnostics nodeBuiltinImport:off - FileSystem cannot create a FIFO.
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const processOutput = (stdout: string) => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const layerProject = WorkspaceFileSystem.layer.pipe(
  Layer.provide(
    Layer.succeed(ProcessRunner.ProcessRunner, { run: () => Effect.succeed(processOutput("[]")) }),
  ),
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
);

const layerTest = Layer.empty.pipe(
  Layer.provideMerge(layerProject),
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-files-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-workspace-files-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

it.layer(layerTest, { excludeTestServices: true })("WorkspaceFileSystemLive", (it) => {
  describe("getMetadata", () => {
    it.effect("expands home-relative paths on the server", () =>
      Effect.gen(function* () {
        const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const home = yield* makeTempDir;
        yield* writeTextFile(home, "file", "hello");
        expect(
          (yield* service
            .getMetadata({ paths: ["~/file"] })
            .pipe(Effect.provideService(HostProcess.HomeDirectory, home))).entries,
        ).toEqual([{ kind: "file", byteLength: 5 }]);
      }),
    );

    it.effect(
      "reports actual kinds for extensionless files, dotfiles, and dotted directories",
      () =>
        Effect.gen(function* () {
          const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          yield* writeTextFile(cwd, "custom-name", "hello");
          yield* writeTextFile(cwd, ".npmrc", "registry=test");
          yield* fs.makeDirectory(path.join(cwd, "folder.ts"));
          const file = path.join(cwd, "custom-name");
          const result = yield* service.getMetadata({
            paths: [
              file,
              path.join(cwd, ".npmrc"),
              path.join(cwd, "folder.ts"),
              file,
              path.join(cwd, "missing"),
              "relative-path",
            ],
          });
          expect(result.entries).toEqual([
            { kind: "file", byteLength: 5 },
            { kind: "file", byteLength: 13 },
            { kind: "directory" },
            { kind: "file", byteLength: 5 },
            null,
            null,
          ]);
        }),
    );

    it.effect("detects an extensionless script and image without returning their contents", () =>
      Effect.gen(function* () {
        const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const script = "#!/usr/bin/env python3\nprint('hello')\n";
        yield* writeTextFile(cwd, "run", script);
        const image = path.join(cwd, "image");
        yield* fs.writeFile(
          image,
          new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        );
        expect(
          (yield* service.getMetadata({ paths: [path.join(cwd, "run"), image] })).entries,
        ).toEqual([
          { kind: "file", byteLength: script.length, mimeType: "text/x-python" },
          { kind: "file", byteLength: 8, mimeType: "image/png" },
        ]);
      }),
    );

    it.effect.skipIf(!symlinksSupported)("follows file and directory symlinks", () =>
      Effect.gen(function* () {
        const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "target", "text");
        yield* fs.makeDirectory(path.join(cwd, "directory"));
        const fileLink = path.join(cwd, "file-link");
        const directoryLink = path.join(cwd, "directory-link");
        yield* fs.symlink(path.join(cwd, "target"), fileLink);
        yield* fs.symlink(path.join(cwd, "directory"), directoryLink);
        expect((yield* service.getMetadata({ paths: [fileLink, directoryLink] })).entries).toEqual([
          { kind: "file", byteLength: 4 },
          { kind: "directory" },
        ]);
      }),
    );
  });

  describe("orchestratorJobs", () => {
    it.effect("discovers running jobs outside registered projects and retains their history", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const command = `node "${path.join(cwd, "tools/orchestration/chain-runner.mjs")}" --cwd "${cwd}" -- node worker.mjs`;
        const service = yield* WorkspaceFileSystem.make.pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, {
            run: () => Effect.succeed(processOutput(encodeJson([command]))),
          }),
        );
        yield* writeTextFile(
          cwd,
          "output/orchestration/chain-state/live.json",
          encodeJson({
            chainState: true,
            chainId: "live",
            phase: "coder_running",
            coder: { pid: process.pid },
          }),
        );
        expect((yield* service.orchestratorJobs({ cwds: [] })).jobs).toMatchObject([
          { id: "live", category: "running", cwd },
        ]);
        yield* writeTextFile(
          cwd,
          "output/orchestration/chain-state/live.json",
          encodeJson({
            chainState: true,
            chainId: "live",
            phase: "ready_for_supervisor",
          }),
        );
        expect((yield* service.orchestratorJobs({ cwds: [] })).jobs).toMatchObject([
          { id: "live", category: "review" },
        ]);
      }).pipe(Effect.provideService(HostProcess.Platform, "win32")),
    );
    it.effect(
      "keeps every active job beyond the old scan limit and only five newest jobs in each other group",
      () =>
        Effect.gen(function* () {
          const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const cwd = yield* makeTempDir;
          const phases = ["coder_running", "ready_for_supervisor", "failed", "accepted"];
          for (let index = 0; index < 208; index++) {
            const phase = phases[index % phases.length]!;
            yield* writeTextFile(
              cwd,
              `output/orchestration/chain-state/job-${index}.json`,
              encodeJson({
                chainState: true,
                chainId: `job-${index}`,
                phase,
                coder: { pid: process.pid },
                updatedAt: `2026-10-02T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}Z`,
              }),
            );
          }
          const result = yield* service.orchestratorJobs({ cwds: [cwd] });
          expect(result.jobs.filter((job) => job.category === "running")).toHaveLength(52);
          for (const category of ["review", "failed", "completed"])
            expect(result.jobs.filter((job) => job.category === category)).toHaveLength(5);
          expect(
            result.jobs.filter((job) => job.category === "completed").map((job) => job.id),
          ).toEqual(["job-207", "job-203", "job-199", "job-195", "job-191"]);
          expect(result.truncated).toBe(false);
        }),
    );
    it.effect("detects stopped workers without treating the checks phase as a stopped worker", () =>
      Effect.gen(function* () {
        const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        for (const phase of ["coder_running", "checks_running"]) {
          yield* writeTextFile(
            cwd,
            `output/orchestration/chain-state/${phase}.json`,
            encodeJson({
              chainState: true,
              chainId: phase,
              phase,
              coder: { pid: 2147483647 },
            }),
          );
        }
        const result = yield* service.orchestratorJobs({ cwds: [cwd] });
        expect(result.jobs.find((job) => job.id === "coder_running")?.category).toBe("failed");
        expect(result.jobs.find((job) => job.id === "checks_running")?.category).toBe("running");
      }),
    );
    it.effect.skipIf(!symlinksSupported)("skips state files linked outside the project", () =>
      Effect.gen(function* () {
        const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outside = yield* makeTempDir;
        yield* writeTextFile(
          outside,
          "job.json",
          encodeJson({ chainState: true, chainId: "outside", phase: "accepted" }),
        );
        yield* fs.makeDirectory(path.join(cwd, "output/orchestration/chain-state"), {
          recursive: true,
        });
        yield* fs.symlink(
          path.join(outside, "job.json"),
          path.join(cwd, "output/orchestration/chain-state/linked.json"),
        );
        expect(yield* service.orchestratorJobs({ cwds: [cwd] })).toEqual({
          jobs: [],
          skippedFiles: 1,
          truncated: false,
        });
      }),
    );
    it.effect("reads chain stages across projects and distinguishes review from acceptance", () =>
      Effect.gen(function* () {
        const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const other = yield* makeTempDir;
        const state = (id: string, phase: string, updatedAt: string) =>
          encodeJson({
            chainState: true,
            chainId: id,
            phase,
            updatedAt,
            task: "Implement the feature\nDetailed instructions remain on disk",
            coder: { model: "coder-model", pid: process.pid },
            reviewer: { model: "reviewer-model", pid: process.pid },
            worktree: { branch: "multi-llm/test", path: "job-worktree" },
          });
        yield* writeTextFile(
          cwd,
          "output/orchestration/chain-state/review.json",
          state("review", "ready_for_supervisor", "2026-10-02T10:00:00Z"),
        );
        yield* writeTextFile(
          other,
          "output/orchestration/chain-state/running.json",
          state("running", "reviewer_running", "2026-10-02T11:00:00Z"),
        );
        yield* writeTextFile(
          cwd,
          "output/orchestration/chain-state/done.json",
          state("done", "accepted", "2026-10-02T09:00:00Z"),
        );
        const result = yield* service.orchestratorJobs({ cwds: [cwd, other, cwd] });
        expect(result.jobs.map((job) => [job.id, job.category])).toEqual([
          ["running", "running"],
          ["review", "review"],
          ["done", "completed"],
        ]);
        expect(result.jobs[0]).toMatchObject({
          model: "reviewer-model",
          task: "Implement the feature",
          branch: "multi-llm/test",
        });
        expect(result.skippedFiles).toBe(0);
      }),
    );
    it.effect("handles absent job folders and skips incomplete or oversized state", () =>
      Effect.gen(function* () {
        const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        expect(yield* service.orchestratorJobs({ cwds: [cwd] })).toEqual({
          jobs: [],
          skippedFiles: 0,
          truncated: false,
        });
        yield* writeTextFile(cwd, "output/orchestration/chain-state/incomplete.json", "{");
        yield* writeTextFile(cwd, "output/orchestration/chain-state/not-a-job.json", "{}");
        yield* writeTextFile(
          cwd,
          "output/orchestration/chain-state/large.json",
          " ".repeat(1024 * 1024 + 1),
        );
        const result = yield* service.orchestratorJobs({ cwds: [cwd] });
        expect(result).toEqual({ jobs: [], skippedFiles: 3, truncated: false });
      }),
    );
    it.effect(
      "maps failures and unknown phases to needs attention without returning worker internals",
      () =>
        Effect.gen(function* () {
          const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const cwd = yield* makeTempDir;
          for (const phase of ["failed", "needs_supervisor", "future_phase"]) {
            yield* writeTextFile(
              cwd,
              `output/orchestration/chain-state/${phase}.json`,
              encodeJson({
                chainState: true,
                chainId: phase,
                phase,
                secret: "not-for-the-client",
                coder: { sessionId: "private-session" },
              }),
            );
          }
          const result = yield* service.orchestratorJobs({ cwds: [cwd] });
          expect(result.jobs.every((job) => job.category === "failed")).toBe(true);
          expect(encodeJson(result)).not.toContain("not-for-the-client");
          expect(encodeJson(result)).not.toContain("private-session");
        }),
    );
  });

  describe("readFile", () => {
    it.effect("reads UTF-8 files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/index.ts", "export const answer = 42;\n");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "src/index.ts",
        });

        expect(result).toEqual({
          relativePath: "src/index.ts",
          contents: "export const answer = 42;\n",
          byteLength: 26,
          truncated: false,
        });
      }),
    );

    it.effect("reads host files outside the workspace root by absolute path", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        yield* writeTextFile(outsideDir, "cleanup-report.md", "# Report\n");
        const absolutePath = path.join(outsideDir, "cleanup-report.md");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: absolutePath,
        });

        expect(result).toEqual({
          relativePath: absolutePath,
          contents: "# Report\n",
          byteLength: 9,
          truncated: false,
        });
      }),
    );

    // Needs mkfifo; Windows has no FIFOs to reject.
    it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
      "rejects a FIFO without blocking on open",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const outsideDir = yield* makeTempDir;
          const fifoPath = path.join(outsideDir, "pipe");
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve, reject) =>
                NodeChildProcess.execFile("mkfifo", [fifoPath], (error) =>
                  error ? reject(error) : resolve(),
                ),
              ),
          );

          const error = yield* workspaceFileSystem
            .readFile({ cwd, relativePath: fifoPath })
            .pipe(Effect.flip);

          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathNotFileError);
          expect((yield* workspaceFileSystem.getMetadata({ paths: [fifoPath] })).entries).toEqual([
            { kind: "other" },
          ]);
        }),
    );

    it.effect("rejects reads outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "../escape.md" })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "rejects symlinks that resolve outside the workspace root",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const outsideDir = yield* makeTempDir;
          yield* writeTextFile(outsideDir, "secret.txt", "outside\n");
          yield* fileSystem.symlink(
            path.join(outsideDir, "secret.txt"),
            path.join(cwd, "linked-secret.txt"),
          );

          const error = yield* workspaceFileSystem
            .readFile({ cwd, relativePath: "linked-secret.txt" })
            .pipe(Effect.flip);
          const resolvedWorkspaceRoot = yield* fileSystem.realPath(cwd);
          const resolvedPath = yield* fileSystem.realPath(path.join(outsideDir, "secret.txt"));

          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
          expect(error).toMatchObject({
            workspaceRoot: cwd,
            relativePath: "linked-secret.txt",
            resolvedWorkspaceRoot,
            resolvedPath,
          });
          expect("cause" in error).toBe(false);
        }),
    );

    it.effect("rejects directories without manufacturing an I/O cause", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* fileSystem.makeDirectory(path.join(cwd, "src"));

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "src" })
          .pipe(Effect.flip);
        const resolvedPath = yield* fileSystem.realPath(path.join(cwd, "src"));

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathNotFileError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "src",
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
      }),
    );

    it.effect("rejects binary files without leaking their contents into the error", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "asset.bin");
        yield* fileSystem.writeFile(absolutePath, Uint8Array.from([0x61, 0, 0x62]));

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "asset.bin" })
          .pipe(Effect.flip);
        const resolvedPath = yield* fileSystem.realPath(absolutePath);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceBinaryFileError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "asset.bin",
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
        expect("contents" in error).toBe(false);
      }),
    );

    it.effect("preserves the real cause and path for I/O failures", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const resolvedPath = path.join(cwd, "missing.txt");

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "missing.txt" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileSystemOperationError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "missing.txt",
          resolvedPath,
          operationPath: resolvedPath,
          operation: "realpath-target",
        });
        expect(error.cause).toBeInstanceOf(Error);
        expect((error.cause as NodeJS.ErrnoException).code).toBe("ENOENT");
      }),
    );
  });

  describe("writeFile", () => {
    it.effect("writes files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });
        const saved = yield* fileSystem
          .readFileString(path.join(cwd, "plans/effect-rpc.md"))
          .pipe(Effect.orDie);

        expect(result).toEqual({ relativePath: "plans/effect-rpc.md" });
        expect(saved).toBe("# Plan\n");
      }),
    );

    it.effect("rejects writes by absolute path", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        const absolutePath = path.join(outsideDir, "cleanup-report.md");

        const error = yield* workspaceFileSystem
          .writeFile({ cwd, relativePath: absolutePath, contents: "# Edited\n" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
      }),
    );

    it.effect("invalidates workspace entry search cache after writes", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/existing.ts", "export {};\n");

        const beforeWrite = yield* workspaceEntries.list({ cwd });
        expect(beforeWrite.entries.some((entry) => entry.path === "plans/effect-rpc.md")).toBe(
          false,
        );

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });

        const afterWrite = yield* workspaceEntries.list({ cwd });
        expect(afterWrite.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "plans/effect-rpc.md" })]),
        );
        expect(afterWrite.truncated).toBe(false);
      }),
    );

    it.effect("rejects writes outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "../escape.md",
            contents: "# nope\n",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );

        const escapedPath = path.resolve(cwd, "..", "escape.md");
        const escapedStat = yield* fileSystem
          .stat(escapedPath)
          .pipe(Effect.orElseSucceed(() => null));
        expect(escapedStat).toBeNull();
      }),
    );
  });
});
