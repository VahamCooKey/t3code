import { describe, expect, it } from "vite-plus/test";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "./auth.ts";
import { CLIENT_GUARDED_RPC_SCOPES, clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { WS_METHODS } from "./rpc.ts";

describe("session group RPC permissions", () => {
  it("requires ordinary orchestration read grants for snapshots and subscriptions", () => {
    expect(clientRpcRequiredScopes(WS_METHODS.sessionGroupsGet, {})).toEqual([
      AuthOrchestrationReadScope,
    ]);
    expect(clientRpcRequiredScopes(WS_METHODS.sessionGroupsWatch, {})).toEqual([
      AuthOrchestrationReadScope,
    ]);
  });

  it.each([
    { type: "create", id: "a", name: "Work" },
    { type: "rename", id: "a", name: "Home" },
    { type: "delete", id: "a" },
    { type: "reorder", ids: ["a"] },
    { type: "membership", id: "a", threadId: "thread-a", member: true },
    { type: "membership", id: "a", threadId: "thread-a", member: false },
  ])("requires an operate grant for $type", (input) => {
    expect(clientRpcRequiredScopes(WS_METHODS.sessionGroupsUpdate, input)).toEqual([
      AuthOrchestrationOperateScope,
    ]);
    expect(CLIENT_GUARDED_RPC_SCOPES[WS_METHODS.sessionGroupsUpdate]).toBe(
      AuthOrchestrationOperateScope,
    );
  });
});
