/**
 * ManagedProjectFolders - the project folders T3 Code makes for the user under
 * its data dir, rather than ones the user picks:
 *
 * - `<baseDir>/scratch`: the Scratch project ("No project"), with a folder of
 *   its own for each thread;
 * - `<baseDir>/projects/<slug>`: projects started from just a name, each a new
 *   Git repository with a README, an icon, and a first commit.
 *
 * @module ManagedProjectFolders
 */
import {
  CommandId,
  type ProjectCopyInput,
  type ProjectCopyResult,
  type GitManagerServiceError,
  ProjectId,
  type ThreadId,
  VcsProcessSpawnError,
} from "@t3tools/contracts";
import { newProjectFolderName } from "@t3tools/shared/path";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as KeyedLock from "@t3tools/shared/KeyedLock";

import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectService from "./ProjectService.ts";

export class ScratchUnavailableError extends Schema.TaggedError<ScratchUnavailableError>()(
  "ScratchUnavailableError",
  {},
) {
  override get message(): string {
    return "Threads without a project are not available on this environment.";
  }
}

export class ScratchFolderError extends Schema.TaggedError<ScratchFolderError>()(
  "ScratchFolderError",
  {
    folder: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to create the folder for threads without a project.";
  }
}

export class ScratchProjectError extends Schema.TaggedError<ScratchProjectError>()(
  "ScratchProjectError",
  {
    workspaceRoot: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to create the project for threads without a project.";
  }
}

export type ScratchError = ScratchUnavailableError | ScratchFolderError | ScratchProjectError;

export class NamedProjectFolderError extends Schema.TaggedError<NamedProjectFolderError>()(
  "NamedProjectFolderError",
  {
    folder: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to create the project folder.";
  }
}

export class NamedProjectCreateError extends Schema.TaggedError<NamedProjectCreateError>()(
  "NamedProjectCreateError",
  {
    workspaceRoot: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to create the project.";
  }
}

export type NamedProjectError = NamedProjectFolderError | NamedProjectCreateError;

export class ProjectCopyError extends Schema.TaggedError<ProjectCopyError>()("ProjectCopyError", {
  projectId: ProjectId,
  reason: Schema.Literals([
    "source_missing",
    "target_exists",
    "same_project",
    "not_repository",
    "no_commit",
  ]),
}) {
  override get message(): string {
    switch (this.reason) {
      case "source_missing":
        return "The source project no longer exists.";
      case "target_exists":
        return "The target project ID is already in use.";
      case "same_project":
        return "The copy needs a new project ID.";
      case "not_repository":
        return "Branch project requires a Git repository. Duplicate project can copy this folder.";
      case "no_commit":
        return "Make a first Git commit before branching this project.";
    }
  }
}

export class ManagedProjectFolders extends Context.Service<
  ManagedProjectFolders,
  {
    /** The Scratch folder, or None when this environment does not offer one. */
    readonly scratchRoot: Effect.Effect<Option.Option<string>>;
    /** Finds or creates the Scratch project and (re)creates its folder. */
    readonly ensureScratchProject: Effect.Effect<{ readonly projectId: ProjectId }, ScratchError>;
    /**
     * Claims a fresh folder for a new thread in the Scratch project, named from
     * the date, its first message, and its id. None for every other project.
     */
    readonly folderForThread: (input: {
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly text: string;
    }) => Effect.Effect<Option.Option<string>, ScratchFolderError>;
    /** The folder that holds projects started from just a name. */
    readonly namedProjectsRoot: string;
    readonly copyProject: (
      input: ProjectCopyInput,
    ) => Effect.Effect<ProjectCopyResult, NamedProjectError | ProjectCopyError>;
    /**
     * Starts a project from just a name: claims `<namedProjectsRoot>/<slug>`
     * (adding `-2`, `-3`, ... when taken), makes it a Git repository with a
     * README, an icon, and a first commit, then creates the project. A failed
     * commit (no Git identity, a signing prompt) keeps the project and returns
     * why in `commitError`. The folder is removed when the create fails or is
     * cancelled before the project exists, never once another project owns it.
     */
    readonly createNamedProject: (input: { readonly name: string }) => Effect.Effect<
      {
        readonly projectId: ProjectId;
        readonly workspaceRoot: string;
        readonly commitError?: string;
      },
      NamedProjectError
    >;
  }
>()("t3/project/ManagedProjectFolders") {}

// Only [a-z0-9] reaches a folder name, so it stays one path segment, and the
// words are capped so a pasted blob cannot outgrow a file name.
const folderWords = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 5)
    .join("-")
    .slice(0, 48)
    .replace(/-+$/, "");

// Tailwind 600 shades: dark enough for white initials on every hue.
const ICON_BACKGROUNDS = [
  "#dc2626",
  "#ea580c",
  "#d97706",
  "#16a34a",
  "#059669",
  "#0d9488",
  "#0891b2",
  "#0284c7",
  "#2563eb",
  "#4f46e5",
  "#7c3aed",
  "#9333ea",
  "#c026d3",
  "#db2777",
  "#e11d48",
] as const;

const MAX_NAMED_FOLDER_ATTEMPTS = 100;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * A rounded square with the name's initials, colored by a hash of the name.
 * It lives at `assets/icon.svg`, a path ProjectFaviconResolver already checks,
 * so every machine that clones the project shows the same icon.
 */
function namedProjectIconSvg(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const initials =
    words
      .slice(0, 2)
      .map((word) => Array.from(word)[0] ?? "")
      .join("")
      .toUpperCase() ||
    Array.from(name.trim())[0] ||
    "?";
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  const background = ICON_BACKGROUNDS[hash % ICON_BACKGROUNDS.length];
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">`,
    `  <rect width="64" height="64" rx="14" fill="${background}"/>`,
    `  <text x="32" y="32" dy="0.35em" text-anchor="middle" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="${initials.length > 1 ? 26 : 32}" font-weight="600" fill="#ffffff">${escapeXml(initials)}</text>`,
    `</svg>`,
    "",
  ].join("\n");
}

function namedProjectReadme(name: string): string {
  return [
    `<img src="assets/icon.svg" width="64" height="64" alt="">`,
    "",
    `# ${name}`,
    "",
    "Created in [T3 Code](https://t3.codes).",
    "",
  ].join("\n");
}

// Git's own identity message runs several lines; say what to do instead.
// Otherwise its last line ("error: gpg failed to sign the data") says enough.
function describeCommitFailure(stderr: string): string {
  if (/identity unknown|tell me who you are|no (name|email) was given/i.test(stderr)) {
    return "Git has no name or email on this machine. Set user.name and user.email, then commit.";
  }
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? "Git could not make the first commit.";
}

const isVcsProcessSpawnError = Schema.is(VcsProcessSpawnError);

// Spawning a `git` that is not on PATH fails with NotFound, on Windows too.
const isGitMissing = (error: GitManagerServiceError) =>
  error._tag === "GitManagerError" &&
  isVcsProcessSpawnError(error.cause) &&
  PlatformError.isPlatformError(error.cause.cause) &&
  error.cause.cause.reason._tag === "NotFound";

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const gitWorkflow = yield* GitWorkflow.GitWorkflowService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const projects = yield* ProjectService.ProjectService;
  const crypto = yield* Crypto.Crypto;
  const copyLocks = yield* KeyedLock.make<ProjectId>();

  /**
   * Claims the first free folder among `folderFor(1)`, `folderFor(2)`, ...,
   * stopping with None when `folderFor` runs out of names. Each folder is
   * created without `recursive`, so creating it is the claim: of two racers
   * for one name, one gets AlreadyExists and moves on to the next. Scratch
   * thread folders and named projects both claim through this, so no two
   * threads or projects ever share a folder.
   */
  const claimFreeFolder = Effect.fnUntraced(function* <E>(
    folderFor: (attempt: number) => Effect.Effect<Option.Option<string>, E>,
    onError: (folder: string, cause: PlatformError.PlatformError) => E,
  ) {
    for (let attempt = 1; ; attempt++) {
      const folder = yield* folderFor(attempt);
      if (Option.isNone(folder)) return folder;
      const claimed = yield* fileSystem.makeDirectory(folder.value).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          () => Effect.succeed(false),
        ),
        Effect.mapError((cause) => onError(folder.value, cause)),
      );
      if (claimed) return folder;
    }
  });

  // Inside a checkout (a dev worktree's .t3, a dotfiles home) the folder would
  // inherit the repo's git status and checkpoints, so Scratch is offered only
  // when the data dir is outside any work tree. With no Git installed nothing
  // can see a checkout, so Scratch is offered. Probed once; other detection
  // failures hide Scratch rather than failing callers. An interrupted probe
  // invalidates the cache so the next caller probes again.
  const [probe, invalidate] = yield* Effect.cachedInvalidateWithTTL(
    gitWorkflow.isRepository(config.baseDir).pipe(
      Effect.catchIf(isGitMissing, () => Effect.succeed(false)),
      Effect.map((isRepository) =>
        isRepository ? Option.none<string>() : Option.some(path.resolve(config.baseDir, "scratch")),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(Option.none<string>()),
      ),
    ),
    Duration.infinity,
  );
  const scratchRoot = probe.pipe(Effect.onInterrupt(() => invalidate));

  const makeScratchFolder = (folder: string) =>
    fileSystem
      .makeDirectory(folder, { recursive: true })
      .pipe(Effect.mapError((cause) => new ScratchFolderError({ folder, cause })));

  const ensureScratchProject: ManagedProjectFolders["Service"]["ensureScratchProject"] = Effect.gen(
    function* () {
      const workspaceRoot = yield* scratchRoot.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new ScratchUnavailableError()),
            onSome: Effect.succeed,
          }),
        ),
      );
      // Re-made on every call, so a deleted Scratch folder still runs threads.
      yield* makeScratchFolder(workspaceRoot);
      const id = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) => new ScratchProjectError({ workspaceRoot, cause })),
      );
      const bootstrapped = yield* projects
        .bootstrap({
          commandId: CommandId.make(`scratch-project:${id}`),
          projectId: ProjectId.make(id),
          title: "No project",
          workspaceRoot,
        })
        .pipe(
          // bootstrap looks the root up before taking the workspace lock, so a
          // racing create loses with a conflict that names the winner.
          Effect.catchTags({
            ProjectConflictError: (conflict) =>
              Effect.succeed({
                project: { id: conflict.conflictingProjectId },
                created: false,
              }),
          }),
          Effect.mapError((cause) => new ScratchProjectError({ workspaceRoot, cause })),
        );
      if (bootstrapped.created) {
        // A dashed chat bubble in neutral gray marks Scratch. Set once at
        // create, so a user's own icon choice is never overwritten.
        yield* projects
          .update({
            commandId: CommandId.make(`scratch-project-icon:${id}`),
            projectId: bootstrapped.project.id,
            projectIcon: { kind: "lucide", name: "message-square-dashed", color: "gray" },
          })
          .pipe(Effect.mapError((cause) => new ScratchProjectError({ workspaceRoot, cause })));
      }
      return { projectId: bootstrapped.project.id };
    },
  );

  const isScratchProject = (projectId: ProjectId, root: string) =>
    projects.getById(projectId).pipe(
      Effect.map(
        Option.exists((project) => path.resolve(project.workspaceRoot) === path.resolve(root)),
      ),
      // An unreadable project is not Scratch; the launch reports its own
      // project lookup failure.
      Effect.orElseSucceed(() => false),
    );

  const folderForThread: ManagedProjectFolders["Service"]["folderForThread"] = Effect.fn(
    "ManagedProjectFolders.folderForThread",
  )(function* (input) {
    const root = yield* scratchRoot;
    if (Option.isNone(root)) return Option.none();
    if (!(yield* isScratchProject(input.projectId, root.value))) return Option.none();
    const date = DateTime.formatIso(yield* DateTime.now).slice(0, 10);
    const words = folderWords(input.text);
    const id = input.threadId.toLowerCase().replace(/[^a-z0-9]/g, "");
    const folderFor = (idPart: string) =>
      path.join(root.value, [date, words, idPart].filter(Boolean).join("-"));
    yield* makeScratchFolder(root.value);
    const fullFolder = folderFor(id);
    // Thread ids often share a prefix ("thread:..."), so the first name uses
    // the id's tail. A taken short name falls back to the full id, which only
    // this thread holds. Ids that normalize alike, or a launch retried without
    // its receipt, can find the full name taken too, so later attempts add a
    // fresh random suffix; the names never run out.
    return yield* claimFreeFolder(
      (attempt) =>
        attempt === 1
          ? Effect.succeed(Option.some(folderFor(id.slice(-8))))
          : attempt === 2
            ? Effect.succeed(Option.some(fullFolder))
            : crypto.randomUUIDv4.pipe(
                Effect.map((uuid) => Option.some(`${fullFolder}-${uuid.slice(0, 8)}`)),
                Effect.mapError((cause) => new ScratchFolderError({ folder: fullFolder, cause })),
              ),
      (folder, cause) => new ScratchFolderError({ folder, cause }),
    );
  });

  // Projects started from just a name live beside Scratch and worktrees, away
  // from folders the user organizes by hand. A nested repository is fine here
  // (unlike Scratch) because each project gets its own `git init`.
  const namedProjectsRoot = path.resolve(config.baseDir, "projects");

  const claimNamedFolder = Effect.fn("ManagedProjectFolders.claimNamedFolder")(function* (
    name: string,
  ) {
    yield* fileSystem
      .makeDirectory(namedProjectsRoot, { recursive: true })
      .pipe(
        Effect.mapError(
          (cause) => new NamedProjectFolderError({ folder: namedProjectsRoot, cause }),
        ),
      );
    const folderName = newProjectFolderName(name);
    const claimed = yield* claimFreeFolder(
      (attempt) =>
        Effect.succeed(
          attempt > MAX_NAMED_FOLDER_ATTEMPTS
            ? Option.none()
            : Option.some(
                path.join(
                  namedProjectsRoot,
                  attempt === 1 ? folderName : `${folderName}-${attempt}`,
                ),
              ),
        ),
      (folder, cause) => new NamedProjectFolderError({ folder, cause }),
    );
    if (Option.isSome(claimed)) return claimed.value;
    return yield* new NamedProjectFolderError({
      folder: path.join(namedProjectsRoot, folderName),
      cause: `Every folder name for "${folderName}" is taken.`,
    });
  });

  // git init, the starter files, and the first commit. Only the commit may
  // fail softly; everything before it fails the create.
  const scaffoldRepository = Effect.fn("ManagedProjectFolders.scaffoldRepository")(function* (
    cwd: string,
    name: string,
  ) {
    const branch =
      (yield* git
        .readConfigValue(cwd, "init.defaultBranch")
        .pipe(Effect.orElseSucceed(() => null))) ?? "main";
    yield* git.execute({
      operation: "ManagedProjectFolders.init",
      cwd,
      args: ["init", `--initial-branch=${branch}`],
      timeoutMs: 10_000,
    });
    yield* fileSystem.writeFileString(path.join(cwd, "README.md"), namedProjectReadme(name));
    yield* fileSystem.makeDirectory(path.join(cwd, "assets"));
    yield* fileSystem.writeFileString(
      path.join(cwd, "assets", "icon.svg"),
      namedProjectIconSvg(name),
    );
    // Named and forced so a global ignore rule (say `*.svg`) cannot drop one.
    yield* git.execute({
      operation: "ManagedProjectFolders.add",
      cwd,
      args: ["add", "--force", "--", "README.md", "assets/icon.svg"],
      timeoutMs: 10_000,
    });
    return yield* git
      .execute({
        operation: "ManagedProjectFolders.commit",
        cwd,
        args: ["commit", "--message", "Initial commit"],
        allowNonZeroExit: true,
        timeoutMs: 30_000,
      })
      .pipe(
        Effect.map((result) =>
          result.exitCode === 0 ? undefined : describeCommitFailure(result.stderr),
        ),
        Effect.catch((error) => Effect.succeed(error.message)),
      );
  });

  const createNamedProject: ManagedProjectFolders["Service"]["createNamedProject"] = Effect.fn(
    "ManagedProjectFolders.createNamedProject",
  )(function* (input) {
    const workspaceRoot = yield* claimNamedFolder(input.name);
    const removeFolder = fileSystem.remove(workspaceRoot, { recursive: true }).pipe(Effect.ignore);
    // Until the create is dispatched nothing else can use the folder, so any
    // exit but success removes it, an interrupt included.
    const prepared = yield* Effect.all([
      scaffoldRepository(workspaceRoot, input.name).pipe(
        Effect.mapError((cause) => new NamedProjectFolderError({ folder: workspaceRoot, cause })),
      ),
      crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) => new NamedProjectCreateError({ workspaceRoot, cause })),
      ),
    ]).pipe(Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : removeFolder)));
    const [commitError, id] = prepared;
    const project = yield* projects
      .create({
        commandId: CommandId.make(`named-project:${id}`),
        projectId: ProjectId.make(id),
        title: input.name,
        workspaceRoot,
      })
      .pipe(
        // A rejected create leaves the folder unused, so remove it. An
        // interrupt can land after the create is committed, and a conflict
        // means another project owns the folder, so it stays then; the owner
        // is checked again first, since deleting another project's files is
        // never acceptable.
        Effect.tapError((error) =>
          error._tag === "ProjectConflictError"
            ? Effect.void
            : projects.getByWorkspaceRoot(workspaceRoot).pipe(
                Effect.flatMap((owner) => (Option.isNone(owner) ? removeFolder : Effect.void)),
                Effect.ignore,
              ),
        ),
        Effect.mapError((cause) => new NamedProjectCreateError({ workspaceRoot, cause })),
      );
    return {
      projectId: project.id,
      workspaceRoot,
      ...(commitError === undefined ? {} : { commitError }),
    };
  });

  const copyProject: ManagedProjectFolders["Service"]["copyProject"] = (input) =>
    copyLocks.withLock(
      input.targetProjectId,
      Effect.gen(function* () {
        if (input.sourceProjectId === input.targetProjectId)
          return yield* new ProjectCopyError({
            projectId: input.targetProjectId,
            reason: "same_project",
          });
        const source = yield* projects
          .getById(input.sourceProjectId)
          .pipe(
            Effect.mapError(
              (cause) => new NamedProjectCreateError({ workspaceRoot: namedProjectsRoot, cause }),
            ),
          );
        const previous = yield* projects
          .getById(input.targetProjectId)
          .pipe(
            Effect.mapError(
              (cause) => new NamedProjectCreateError({ workspaceRoot: namedProjectsRoot, cause }),
            ),
          );
        const branch =
          input.mode === "branch"
            ? `t3/${newProjectFolderName(input.name)}-${input.targetProjectId}`
            : null;
        if (Option.isSome(previous)) {
          // Re-submit through the project service to verify this command owns the target.
          yield* projects
            .create({
              commandId: input.commandId,
              projectId: input.targetProjectId,
              title: input.name,
              workspaceRoot: previous.value.workspaceRoot,
            })
            .pipe(
              Effect.mapError(
                () =>
                  new ProjectCopyError({
                    projectId: input.targetProjectId,
                    reason: "target_exists",
                  }),
              ),
            );
          if (Option.isSome(source)) {
            yield* projects
              .update({
                commandId: CommandId.make(`${input.commandId}:settings`),
                projectId: input.targetProjectId,
                defaultModelSelection: source.value.defaultModelSelection,
                defaultThreadEnvMode: source.value.defaultThreadEnvMode,
                projectIcon: source.value.projectIcon,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new NamedProjectCreateError({
                      workspaceRoot: previous.value.workspaceRoot,
                      cause,
                    }),
                ),
              );
          }
          return {
            projectId: previous.value.id,
            workspaceRoot: previous.value.workspaceRoot,
            branch,
          };
        }
        if (Option.isNone(source))
          return yield* new ProjectCopyError({
            projectId: input.sourceProjectId,
            reason: "source_missing",
          });
        const cwd = source.value.workspaceRoot;
        const isRepository = yield* gitWorkflow
          .isRepository(cwd)
          .pipe(Effect.mapError((cause) => new NamedProjectFolderError({ folder: cwd, cause })));
        let hasCommit = false;
        if (isRepository) {
          const head = yield* git
            .execute({
              operation: "ManagedProjectFolders.head",
              cwd,
              args: ["rev-parse", "--verify", "HEAD"],
              allowNonZeroExit: true,
              timeoutMs: 10_000,
            })
            .pipe(Effect.mapError((cause) => new NamedProjectFolderError({ folder: cwd, cause })));
          hasCommit = head.exitCode === 0;
        }
        if (input.mode === "branch" && !isRepository)
          return yield* new ProjectCopyError({
            projectId: input.sourceProjectId,
            reason: "not_repository",
          });
        if (input.mode === "branch" && !hasCommit)
          return yield* new ProjectCopyError({
            projectId: input.sourceProjectId,
            reason: "no_commit",
          });
        const sourcePath = yield* fileSystem
          .realPath(cwd)
          .pipe(Effect.mapError((cause) => new NamedProjectFolderError({ folder: cwd, cause })));
        const workspaceRoot = yield* claimNamedFolder(input.name);
        const folderError = (cause: unknown) =>
          new NamedProjectFolderError({ folder: workspaceRoot, cause });
        // A dev data directory can sit inside the source. Never recurse into the new copy.
        const excluded = new Set([".git", ".t3", "node_modules", ".vite-plus"]);
        let worktreeCreated = false;
        const prepare =
          input.mode === "branch"
            ? git
                .execute({
                  operation: "ManagedProjectFolders.branch",
                  cwd,
                  args: ["worktree", "add", "-b", branch!, workspaceRoot, "HEAD"],
                  timeoutMs: 60_000,
                })
                .pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      worktreeCreated = true;
                    }),
                  ),
                  Effect.asVoid,
                )
            : Effect.gen(function* () {
                if (isRepository) {
                  yield* git.execute({
                    operation: "ManagedProjectFolders.clone",
                    cwd,
                    args: ["clone", "--local", "--no-hardlinks", "--", sourcePath, workspaceRoot],
                    timeoutMs: 60_000,
                  });
                  // A local clone invents an origin pointing at the source folder.
                  // Preserve the user's remotes so a push cannot write into that folder.
                  yield* git.execute({
                    operation: "ManagedProjectFolders.removeCloneOrigin",
                    cwd: workspaceRoot,
                    args: ["remote", "remove", "origin"],
                    timeoutMs: 10_000,
                  });
                  const remotes = yield* git.execute({
                    operation: "ManagedProjectFolders.remotes",
                    cwd,
                    args: ["remote"],
                    timeoutMs: 10_000,
                  });
                  for (const remote of remotes.stdout.trim().split(/\r?\n/).filter(Boolean)) {
                    const urls = yield* git.execute({
                      operation: "ManagedProjectFolders.remoteUrls",
                      cwd,
                      args: ["remote", "get-url", "--all", remote],
                      timeoutMs: 10_000,
                    });
                    const fetchUrls = urls.stdout.trim().split(/\r?\n/).filter(Boolean);
                    if (fetchUrls.length === 0) continue;
                    yield* git.execute({
                      operation: "ManagedProjectFolders.addRemote",
                      cwd: workspaceRoot,
                      args: ["remote", "add", remote, fetchUrls[0]!],
                      timeoutMs: 10_000,
                    });
                    for (const url of fetchUrls.slice(1))
                      yield* git.execute({
                        operation: "ManagedProjectFolders.addRemoteUrl",
                        cwd: workspaceRoot,
                        args: ["remote", "set-url", "--add", remote, url],
                        timeoutMs: 10_000,
                      });
                    const pushUrls = yield* git.execute({
                      operation: "ManagedProjectFolders.pushUrls",
                      cwd,
                      args: ["config", "--get-all", `remote.${remote}.pushurl`],
                      allowNonZeroExit: true,
                      timeoutMs: 10_000,
                    });
                    for (const url of pushUrls.stdout.trim().split(/\r?\n/).filter(Boolean))
                      yield* git.execute({
                        operation: "ManagedProjectFolders.addPushUrl",
                        cwd: workspaceRoot,
                        args: ["remote", "set-url", "--add", "--push", remote, url],
                        timeoutMs: 10_000,
                      });
                  }
                }
                const copyDirectory = (
                  from: string,
                  to: string,
                ): Effect.Effect<void, PlatformError.PlatformError> =>
                  Effect.gen(function* () {
                    const entries = yield* fileSystem.readDirectory(from);
                    for (const name of entries) {
                      if (excluded.has(name)) continue;
                      const entry = path.join(from, name);
                      if (entry === workspaceRoot) continue;
                      const destination = path.join(to, name);
                      // Inspect the link before stat, which follows it. Cyclic and external
                      // directory links must stay links instead of expanding into the copy.
                      const link = yield* fileSystem.readLink(entry).pipe(Effect.option);
                      if (Option.isSome(link)) {
                        yield* fileSystem.remove(destination, { force: true });
                        yield* fileSystem.symlink(link.value, destination);
                        continue;
                      }
                      const stat = yield* fileSystem.stat(entry);
                      if (stat.type === "Directory") {
                        yield* fileSystem.makeDirectory(destination, { recursive: true });
                        yield* copyDirectory(entry, destination);
                      } else {
                        yield* fileSystem.copy(entry, destination, { overwrite: true });
                      }
                    }
                  });
                yield* copyDirectory(sourcePath, workspaceRoot);
                // A clone checks out HEAD; remove tracked files deleted in the source too.
                if (isRepository && hasCommit) {
                  const deleted = yield* git.execute({
                    operation: "ManagedProjectFolders.deletedFiles",
                    cwd,
                    args: ["diff", "--name-only", "--diff-filter=D", "-z", "HEAD", "--"],
                    timeoutMs: 10_000,
                  });
                  for (const relative of deleted.stdout.split("\0").filter(Boolean)) {
                    const target = path.resolve(workspaceRoot, relative);
                    const within = path.relative(workspaceRoot, target);
                    if (within.startsWith("..") || path.isAbsolute(within)) continue;
                    yield* fileSystem.remove(target, { force: true });
                  }
                }
              });
        const cleanup = Effect.gen(function* () {
          const owner = yield* projects.getByWorkspaceRoot(workspaceRoot);
          if (Option.isSome(owner)) return;
          if (worktreeCreated) {
            yield* git.execute({
              operation: "ManagedProjectFolders.removeBranchWorktree",
              cwd,
              args: ["worktree", "remove", "--force", workspaceRoot],
              allowNonZeroExit: true,
              timeoutMs: 30_000,
            });
            yield* git.execute({
              operation: "ManagedProjectFolders.removeBranch",
              cwd,
              args: ["branch", "-D", branch!],
              allowNonZeroExit: true,
              timeoutMs: 10_000,
            });
          }
          yield* fileSystem.remove(workspaceRoot, { recursive: true, force: true });
        }).pipe(Effect.ignore);
        return yield* Effect.gen(function* () {
          yield* prepare.pipe(Effect.mapError(folderError));
          // Creation and settings copy finish together, including on client disconnect.
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              yield* projects.create({
                commandId: input.commandId,
                projectId: input.targetProjectId,
                title: input.name,
                workspaceRoot,
                scripts: source.value.scripts,
              });
              yield* projects.update({
                commandId: CommandId.make(`${input.commandId}:settings`),
                projectId: input.targetProjectId,
                defaultModelSelection: source.value.defaultModelSelection,
                defaultThreadEnvMode: source.value.defaultThreadEnvMode,
                projectIcon: source.value.projectIcon,
              });
            }),
          ).pipe(Effect.mapError((cause) => new NamedProjectCreateError({ workspaceRoot, cause })));
          return { projectId: input.targetProjectId, workspaceRoot, branch };
        }).pipe(Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : cleanup)));
      }),
    );

  return ManagedProjectFolders.of({
    scratchRoot,
    ensureScratchProject,
    folderForThread,
    namedProjectsRoot,
    createNamedProject,
    copyProject,
  });
});

export const layer = Layer.effect(ManagedProjectFolders, make);
