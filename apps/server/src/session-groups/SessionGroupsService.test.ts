import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EventId,
  ProjectId,
  ProviderInstanceId,
  SessionGroupsSnapshot,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SessionGroups from "./SessionGroupsService.ts";

const decodeSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(SessionGroupsSnapshot));
const layerThreads = Layer.unwrap(
  Effect.map(ProjectionStore.ProjectionStoreV2, (projections) =>
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) => projections.getThreadShell(id).pipe(Effect.orDie),
    }),
  ),
);

const layerTest = () =>
  SessionGroups.layer.pipe(
    Layer.provideMerge(layerThreads),
    Layer.provideMerge(Layer.fresh(ProjectionStore.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3-session-groups-" })),
    ),
  );

const createThread = Effect.fnUntraced(function* (id: string, project: string, provider: string) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(id);
  const providerInstanceId = ProviderInstanceId.make(provider);
  yield* projections.apply({
    id: EventId.make(`create-${id}`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make(project),
      title: id,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "test" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  return threadId;
});

const groupsPath = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(config.stateDir, "session-groups.json");
});

it.layer(NodeServices.layer)("SessionGroupsService", (it) => {
  it.effect(
    "persists cross-project/provider multi-membership, rename/order and survives reconstruction",
    () =>
      Effect.gen(function* () {
        const service = yield* SessionGroups.SessionGroupsService;
        const fs = yield* FileSystem.FileSystem;
        const threadA = yield* createThread("thread-a", "project-a", "codex");
        const threadB = yield* createThread("thread-b", "project-b", "claude");
        assert.deepEqual(yield* service.get, { groups: [] });
        yield* service.update({ type: "create", id: "a", name: "Work" });
        yield* service.update({ type: "create", id: "b", name: "Home" });
        yield* service.update({ type: "membership", id: "a", threadId: threadA, member: true });
        yield* service.update({ type: "membership", id: "a", threadId: threadB, member: true });
        yield* service.update({ type: "membership", id: "b", threadId: threadA, member: true });
        yield* service.update({ type: "rename", id: "a", name: "  Client work  " });
        const expected = yield* service.update({ type: "reorder", ids: ["b", "a"] });
        assert.deepEqual(expected.groups, [
          { id: "b", name: "Home", threadIds: [threadA] },
          { id: "a", name: "Client work", threadIds: [threadA, threadB] },
        ]);
        assert.deepEqual(
          yield* decodeSnapshot(yield* fs.readFileString(yield* groupsPath)),
          expected,
        );
        const reloaded = yield* Effect.gen(function* () {
          return yield* (yield* SessionGroups.SessionGroupsService).get;
        }).pipe(Effect.provide(Layer.fresh(SessionGroups.layer)));
        assert.deepEqual(reloaded, expected);
        yield* service.update({ type: "delete", id: "a" });
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        assert.isNotNull(yield* projections.getThreadShell(threadA));
        assert.isNotNull(yield* projections.getThreadShell(threadB));
        assert.deepEqual((yield* service.get).groups, expected.groups.slice(0, 1));
      }).pipe(Effect.provide(layerTest())),
  );

  it.effect(
    "serializes concurrent writes and preserves additions omitted by stale reorder requests",
    () =>
      Effect.gen(function* () {
        const service = yield* SessionGroups.SessionGroupsService;
        const thread = yield* createThread("thread-a", "project-a", "codex");
        yield* Effect.all(
          Array.from({ length: 12 }, (_, index) =>
            service.update({ type: "create", id: `g-${index}`, name: `Group ${index}` }),
          ),
          { concurrency: "unbounded" },
        );
        yield* Effect.all(
          Array.from({ length: 12 }, (_, index) =>
            service.update({
              type: "membership",
              id: `g-${index}`,
              threadId: thread,
              member: true,
            }),
          ),
          { concurrency: "unbounded" },
        );
        const current = yield* service.get;
        assert.equal(current.groups.length, 12);
        assert.isTrue(current.groups.every((group) => group.threadIds.length === 1));
        const reordered = yield* service.update({
          type: "reorder",
          ids: ["g-4", "missing", "g-4", "g-0"],
        });
        assert.deepEqual(
          reordered.groups.map((group) => group.id),
          [
            "g-4",
            "g-0",
            ...current.groups
              .filter((group) => group.id !== "g-4" && group.id !== "g-0")
              .map((group) => group.id),
          ],
        );
        assert.deepEqual(yield* service.update({ type: "reorder", ids: [] }), reordered);
      }).pipe(Effect.provide(layerTest())),
  );

  it.effect("retries create ids and membership idempotently and removes stale membership", () =>
    Effect.gen(function* () {
      const service = yield* SessionGroups.SessionGroupsService;
      const thread = yield* createThread("thread-a", "project-a", "codex");
      yield* service.update({ type: "create", id: "a", name: "Original" });
      yield* service.update({ type: "create", id: "a", name: "Retried" });
      yield* service.update({ type: "membership", id: "a", threadId: thread, member: true });
      const duplicate = yield* service.update({
        type: "membership",
        id: "a",
        threadId: thread,
        member: true,
      });
      assert.deepEqual(duplicate.groups, [{ id: "a", name: "Original", threadIds: [thread] }]);
      const missing = yield* service
        .update({ type: "membership", id: "a", threadId: ThreadId.make("missing"), member: true })
        .pipe(Effect.flip);
      assert.equal(missing.reason, "thread-not-found");
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const payload = yield* projections.getThread(thread);
      const now = yield* DateTime.now;
      yield* projections.apply({
        id: EventId.make("delete-a"),
        type: "thread.deleted",
        threadId: thread,
        occurredAt: now,
        payload: { ...payload, deletedAt: now },
      });
      const deleted = yield* service
        .update({ type: "membership", id: "a", threadId: thread, member: true })
        .pipe(Effect.flip);
      assert.equal(deleted.reason, "thread-not-found");
      const removed = yield* service.update({
        type: "membership",
        id: "a",
        threadId: thread,
        member: false,
      });
      assert.deepEqual(removed.groups[0]?.threadIds, []);
      assert.deepEqual(
        yield* service.update({ type: "membership", id: "a", threadId: thread, member: false }),
        removed,
      );
      yield* service.update({ type: "delete", id: "a" });
      assert.deepEqual(yield* service.update({ type: "delete", id: "a" }), { groups: [] });
      assert.equal(
        (yield* service.update({ type: "rename", id: "a", name: "Missing" }).pipe(Effect.flip))
          .reason,
        "not-found",
      );
    }).pipe(Effect.provide(layerTest())),
  );

  it.effect(
    "watch starts with current state, streams durable writes, and emits no duplicate no-op updates",
    () =>
      Effect.gen(function* () {
        const service = yield* SessionGroups.SessionGroupsService;
        const fs = yield* FileSystem.FileSystem;
        const file = yield* groupsPath;
        const ready = yield* Deferred.make<void>();
        const watcher = yield* service.watch.pipe(
          Stream.tap((snapshot) =>
            snapshot.groups.length === 0
              ? Deferred.succeed(ready, undefined)
              : Effect.gen(function* () {
                  assert.deepEqual(yield* decodeSnapshot(yield* fs.readFileString(file)), snapshot);
                }),
          ),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Deferred.await(ready);
        yield* service.update({ type: "delete", id: "missing" });
        const created = yield* service.update({ type: "create", id: "a", name: "Work" });
        assert.deepEqual(Array.from(yield* Fiber.join(watcher)), [{ groups: [] }, created]);
        yield* service.update({ type: "create", id: "a", name: "Retry" });
        assert.deepEqual(Option.getOrThrow(yield* Stream.runHead(service.watch)), created);
      }).pipe(Effect.provide(layerTest())),
  );

  it.effect("preserves corrupt files, rejects writes, and can load a repaired file", () =>
    Effect.gen(function* () {
      const service = yield* SessionGroups.SessionGroupsService;
      const fs = yield* FileSystem.FileSystem;
      const file = yield* groupsPath;
      yield* fs.writeFileString(file, "{broken-json");
      assert.equal((yield* service.get.pipe(Effect.flip)).reason, "corrupt");
      assert.equal((yield* Stream.runHead(service.watch).pipe(Effect.flip)).reason, "corrupt");
      assert.equal(
        (yield* service.update({ type: "create", id: "a", name: "Work" }).pipe(Effect.flip)).reason,
        "corrupt",
      );
      assert.equal(yield* fs.readFileString(file), "{broken-json");
      yield* fs.writeFileString(
        file,
        JSON.stringify({
          groups: Array.from({ length: 200 }, (_, index) => ({
            id: `g-${index}`,
            name: `Group ${index}`,
            threadIds: [],
          })),
        }),
      );
      const snapshot = yield* service.update({ type: "create", id: "extra", name: "Extra" });
      assert.equal(snapshot.groups.length, 201);
    }).pipe(Effect.provide(layerTest())),
  );

  it.effect("a failed atomic replacement leaves disk, current state and watch unchanged", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* groupsPath;
      const saved = { groups: [{ id: "a", name: "Saved", threadIds: [] }] };
      yield* fs.writeFileString(file, JSON.stringify(saved));
      let failRename = true;
      const failingFs = {
        ...fs,
        rename: (from: string, to: string) =>
          failRename
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "rename",
                }),
              )
            : fs.rename(from, to),
      };
      yield* Effect.gen(function* () {
        const service = yield* SessionGroups.SessionGroupsService;
        const ready = yield* Deferred.make<void>();
        const watcher = yield* service.watch.pipe(
          Stream.tap(() => Deferred.succeed(ready, undefined)),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Deferred.await(ready);
        assert.equal(
          (yield* service.update({ type: "rename", id: "a", name: "Failed" }).pipe(Effect.flip))
            .reason,
          "write",
        );
        assert.deepEqual(yield* service.get, saved);
        assert.deepEqual(yield* decodeSnapshot(yield* fs.readFileString(file)), saved);
        failRename = false;
        const updated = yield* service.update({ type: "rename", id: "a", name: "Success" });
        assert.deepEqual(Array.from(yield* Fiber.join(watcher)), [saved, updated]);
      }).pipe(
        Effect.provide(Layer.fresh(SessionGroups.layer)),
        Effect.provideService(FileSystem.FileSystem, failingFs),
      );
    }).pipe(Effect.provide(layerTest())),
  );

  it.effect("registers standard remote scopes for every RPC without requiring admin", () =>
    Effect.sync(() => {
      assert.equal(
        RpcAuthorization.requiredScopeForRpcMethod(WS_METHODS.sessionGroupsGet),
        AuthOrchestrationReadScope,
      );
      assert.equal(
        RpcAuthorization.requiredScopeForRpcMethod(WS_METHODS.sessionGroupsWatch),
        AuthOrchestrationReadScope,
      );
      assert.equal(
        RpcAuthorization.requiredScopeForRpcMethod(WS_METHODS.sessionGroupsUpdate),
        AuthOrchestrationOperateScope,
      );
    }),
  );
});
