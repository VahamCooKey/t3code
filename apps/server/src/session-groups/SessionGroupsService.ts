import { SessionGroupsError, SessionGroupsSnapshot, SessionGroupsUpdate } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ServerConfig from "../config.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

const decodeSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(SessionGroupsSnapshot));
const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(SessionGroupsSnapshot));
const decodeUpdate = Schema.decodeUnknownEffect(SessionGroupsUpdate);

export class SessionGroupsService extends Context.Service<
  SessionGroupsService,
  {
    readonly get: Effect.Effect<SessionGroupsSnapshot, SessionGroupsError>;
    /** Emits the current snapshot on subscription, then every durable change. */
    readonly watch: Stream.Stream<SessionGroupsSnapshot, SessionGroupsError>;
    readonly update: (
      input: SessionGroupsUpdate,
    ) => Effect.Effect<SessionGroupsSnapshot, SessionGroupsError>;
  }
>()("t3/session-groups/SessionGroupsService") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const filePath = path.join(config.stateDir, "session-groups.json");
  const state = yield* SubscriptionRef.make<SessionGroupsSnapshot>({ groups: [] });
  const lock = yield* Semaphore.make(1);
  let loaded = false;

  // Only a missing file means empty preferences. A broken file remains untouched,
  // and loading stays retryable so repairing it does not require restarting the server.
  const load = Effect.gen(function* () {
    if (loaded) return yield* SubscriptionRef.get(state);
    const contents = yield* fs.readFileString(filePath).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(null),
      ),
      Effect.mapError((cause) => new SessionGroupsError({ reason: "read", cause })),
    );
    const snapshot =
      contents === null
        ? { groups: [] }
        : yield* decodeSnapshot(contents).pipe(
            Effect.mapError((cause) => new SessionGroupsError({ reason: "corrupt", cause })),
          );
    yield* SubscriptionRef.set(state, snapshot);
    loaded = true;
    return snapshot;
  });

  const get = lock.withPermits(1)(load);
  const update = Effect.fn("SessionGroupsService.update")(function* (input: SessionGroupsUpdate) {
    const command = yield* decodeUpdate(input).pipe(
      Effect.mapError((cause) => new SessionGroupsError({ reason: "invalid-input", cause })),
    );
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* load;
        let groups = current.groups;
        const group =
          command.type === "reorder" ? undefined : groups.find((entry) => entry.id === command.id);
        switch (command.type) {
          case "create":
            if (group !== undefined) return current;
            groups = [...groups, { id: command.id, name: command.name, threadIds: [] }];
            break;
          case "delete":
            if (group === undefined) return current;
            groups = groups.filter((entry) => entry.id !== command.id);
            break;
          case "rename":
            if (group === undefined) return yield* new SessionGroupsError({ reason: "not-found" });
            if (group.name === command.name) return current;
            groups = groups.map((entry) =>
              entry.id === command.id ? { ...entry, name: command.name } : entry,
            );
            break;
          case "membership": {
            if (group === undefined) return yield* new SessionGroupsError({ reason: "not-found" });
            // Removals also work for stale ids after a thread is deleted. Additions
            // require a live thread; the shell projection excludes deleted threads.
            if (command.member) {
              const thread = yield* threads
                .getThreadShell(command.threadId)
                .pipe(
                  Effect.mapError(
                    (cause) => new SessionGroupsError({ reason: "thread-read", cause }),
                  ),
                );
              if (thread === null)
                return yield* new SessionGroupsError({ reason: "thread-not-found" });
            }
            if (group.threadIds.includes(command.threadId) === command.member) return current;
            const threadIds = command.member
              ? [...group.threadIds, command.threadId]
              : group.threadIds.filter((id) => id !== command.threadId);
            groups = groups.map((entry) =>
              entry.id === command.id ? { ...entry, threadIds } : entry,
            );
            break;
          }
          case "reorder": {
            const byId = new Map(groups.map((entry) => [entry.id, entry]));
            const ordered = [];
            for (const id of command.ids) {
              const entry = byId.get(id);
              if (entry !== undefined) {
                ordered.push(entry);
                byId.delete(id);
              }
            }
            // A stale client's order must preserve groups created by another client.
            groups = [...ordered, ...byId.values()];
            if (groups.every((entry, index) => entry === current.groups[index])) return current;
            break;
          }
        }
        const snapshot = { groups };
        const contents = yield* encodeSnapshot(snapshot).pipe(
          Effect.mapError((cause) => new SessionGroupsError({ reason: "write", cause })),
        );
        // Once the write starts, cancellation cannot leave disk and subscribers disagreeing.
        yield* writeFileStringAtomically({ filePath, contents }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.mapError((cause) => new SessionGroupsError({ reason: "write", cause })),
        );
        yield* SubscriptionRef.set(state, snapshot);
        return snapshot;
      }).pipe(Effect.uninterruptible),
    );
  });

  return SessionGroupsService.of({
    get,
    update,
    // SubscriptionRef's replay is acquired with subscription: no read/subscribe gap.
    watch: Stream.unwrap(Effect.as(get, SubscriptionRef.changes(state))),
  });
});

export const layer = Layer.effect(SessionGroupsService, make);
