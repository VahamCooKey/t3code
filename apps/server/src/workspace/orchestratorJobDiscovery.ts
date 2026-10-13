import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../processRunner.ts";

const decodeCommands = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const workerScript = /(?:^|[/\\])(?:chain-runner|codex-worker|claude-worker)\.mjs$/;

// Inspect only the executable and script arguments, never model prompts after `--`.
export function orchestratorRootsFromArgs(args: readonly string[], path: Path.Path) {
  const scriptIndex = args.findIndex((arg, index) => index > 0 && !arg.startsWith("-"));
  if (scriptIndex < 0 || !workerScript.test(args[scriptIndex]!)) return [];
  const end = args.indexOf("--", scriptIndex + 1);
  const flags = args.slice(scriptIndex + 1, end < 0 ? undefined : end);
  const cwdIndex = flags.indexOf("--cwd");
  const cwd = cwdIndex >= 0 ? flags[cwdIndex + 1] : undefined;
  const script = args[scriptIndex]!;
  const roots = cwd && path.isAbsolute(cwd) ? [cwd] : [];
  if (path.isAbsolute(script) && /[/\\]tools[/\\]orchestration[/\\]/.test(script)) {
    roots.push(path.dirname(path.dirname(path.dirname(script))));
  }
  return roots;
}

const windowsCommands = String.raw`
$ErrorActionPreference = 'Stop'
$commands = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'bun.exe'" |
  Where-Object { $_.CommandLine -match '(chain-runner|codex-worker|claude-worker)\.mjs' } |
  ForEach-Object { ($_.CommandLine -split ' -- ', 2)[0] })
ConvertTo-Json -InputObject $commands -Compress
`;

export const discoverOrchestratorRoots = Effect.fn("discoverOrchestratorRoots")(function* () {
  const platform = yield* HostProcess.Platform;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* ProcessRunner.ProcessRunner;
  const result = yield* runner.run({
    command: platform === "win32" ? "powershell.exe" : "ps",
    args:
      platform === "win32"
        ? ["-NoProfile", "-NonInteractive", "-Command", windowsCommands]
        : ["-ww", "-axo", platform === "linux" ? "pid=,args=" : "command="],
    timeout: "4 seconds",
    maxOutputBytes: 2 * 1024 * 1024,
  });
  if (result.code !== 0) return { roots: [], unavailable: true };
  let commands: readonly (readonly string[])[];
  if (platform === "linux") {
    const pids = result.stdout
      .split("\n")
      .filter((line) => /(?:chain-runner|codex-worker|claude-worker)\.mjs/.test(line))
      .flatMap((line) => line.match(/^\s*(\d+)\s/)?.[1] ?? []);
    commands = yield* Effect.forEach(
      pids,
      (pid) =>
        fs.readFileString(`/proc/${pid}/cmdline`).pipe(
          Effect.map((line) => line.split("\0")),
          Effect.orElseSucceed(() => [] as string[]),
        ),
      { concurrency: 8 },
    );
  } else {
    const lines =
      platform === "win32"
        ? yield* decodeCommands(result.stdout.trim())
        : result.stdout.split("\n");
    commands = lines.map((line) => tokenizeCliArgs(line));
  }
  return {
    roots: [...new Set(commands.flatMap((args) => orchestratorRootsFromArgs(args, path)))],
    unavailable: false,
  };
});
