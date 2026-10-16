import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  type AuthEnvironmentScope,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SessionGroups from "./SessionGroupsService.ts";

const tested = [
  WS_METHODS.sessionGroupsGet,
  WS_METHODS.sessionGroupsWatch,
  WS_METHODS.sessionGroupsUpdate,
] as const;
const group = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (
      tag,
    ): tag is Exclude<keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
      !(tested as readonly string[]).includes(tag),
  ),
);

const handlers = group.toLayer(
  Effect.gen(function* () {
    const service = yield* SessionGroups.SessionGroupsService;
    return group.of({
      [WS_METHODS.sessionGroupsGet]: () => service.get,
      [WS_METHODS.sessionGroupsWatch]: () => service.watch,
      [WS_METHODS.sessionGroupsUpdate]: (input) => service.update(input),
    });
  }),
);

const makeClient = (scopes: readonly AuthEnvironmentScope[]) =>
  RpcTest.makeClient(group).pipe(
    Effect.provide(Layer.merge(handlers, RpcAuthorization.layer(scopes))),
  );

const layerTest = () =>
  SessionGroups.layer.pipe(
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(null),
      }),
    ),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-session-groups-rpc-" })),
  );

it.layer(NodeServices.layer)("session groups RPC", (it) => {
  it.effect("read-only remote clients get/watch state but cannot mutate it", () =>
    Effect.gen(function* () {
      const client = yield* makeClient([AuthOrchestrationReadScope]);
      assert.deepEqual(yield* client[WS_METHODS.sessionGroupsGet]({}), { groups: [] });
      assert.deepEqual(
        Option.getOrThrow(yield* Stream.runHead(client[WS_METHODS.sessionGroupsWatch]({}))),
        { groups: [] },
      );
      const denied = yield* client[WS_METHODS.sessionGroupsUpdate]({
        type: "create",
        id: "a",
        name: "Denied",
      }).pipe(Effect.flip);
      assert.equal(denied._tag, "EnvironmentAuthorizationError");
      if (denied._tag === "EnvironmentAuthorizationError")
        assert.equal(denied.requiredPermission, AuthOrchestrationOperateScope);
      assert.deepEqual(yield* client[WS_METHODS.sessionGroupsGet]({}), { groups: [] });
    }).pipe(Effect.provide(layerTest())),
  );

  it.effect("ordinary read/operate grants can mutate and observe groups without admin", () =>
    Effect.gen(function* () {
      const client = yield* makeClient([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);
      const created = yield* client[WS_METHODS.sessionGroupsUpdate]({
        type: "create",
        id: "a",
        name: "Work",
      });
      assert.deepEqual(created, { groups: [{ id: "a", name: "Work", threadIds: [] }] });
      assert.deepEqual(yield* client[WS_METHODS.sessionGroupsGet]({}), created);
      assert.deepEqual(
        Option.getOrThrow(yield* Stream.runHead(client[WS_METHODS.sessionGroupsWatch]({}))),
        created,
      );
      assert.deepEqual(yield* client[WS_METHODS.sessionGroupsUpdate]({ type: "delete", id: "a" }), {
        groups: [],
      });
    }).pipe(Effect.provide(layerTest())),
  );

  it.effect("ungranted clients cannot read or subscribe", () =>
    Effect.gen(function* () {
      const client = yield* makeClient([]);
      const getError = yield* client[WS_METHODS.sessionGroupsGet]({}).pipe(Effect.flip);
      assert.equal(getError._tag, "EnvironmentAuthorizationError");
      const watchError = yield* Stream.runHead(client[WS_METHODS.sessionGroupsWatch]({})).pipe(
        Effect.flip,
      );
      assert.equal(watchError._tag, "EnvironmentAuthorizationError");
    }).pipe(Effect.provide(layerTest())),
  );
});
