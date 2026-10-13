import { describe, expect, it } from "@effect/vitest";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { orchestratorRootsFromArgs } from "./orchestratorJobDiscovery.ts";

describe("orchestrator process discovery", () => {
  it.effect(
    "finds external worktrees and script roots without interpreting the task arguments",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const scriptRoot = path.resolve("project with spaces");
        const worktree = path.resolve("other worktree");
        expect(
          orchestratorRootsFromArgs(
            [
              "node",
              path.join(scriptRoot, "tools/orchestration/chain-runner.mjs"),
              "--cwd",
              worktree,
              "--",
              "node",
              "worker.mjs",
              "--cwd",
              path.resolve("prompt-path"),
            ],
            path,
          ),
        ).toEqual([worktree, scriptRoot]);
        expect(
          orchestratorRootsFromArgs(
            ["node", path.join(scriptRoot, "tools/orchestration/codex-worker.mjs")],
            path,
          ),
        ).toEqual([scriptRoot]);
        expect(
          orchestratorRootsFromArgs(
            ["node", "unrelated.mjs", "--prompt", "chain-runner.mjs", "--cwd", worktree],
            path,
          ),
        ).toEqual([]);
      }).pipe(Effect.provide(NodePath.layer)),
  );
});
