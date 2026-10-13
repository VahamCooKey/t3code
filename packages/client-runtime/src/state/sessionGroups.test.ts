import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ThreadId,
  WS_METHODS,
  type AuthSessionState,
  type SessionGroupsSnapshot,
  type SessionGroupsUpdate,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createSessionGroupsAtoms } from "./sessionGroups.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const first = EnvironmentId.make("first");
const second = EnvironmentId.make("second");
const grant = (allowed: boolean): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: allowed ? [AuthOrchestrationOperateScope] : [],
  permissions: allowed ? [AuthOrchestrationOperateScope] : [],
});

const harness = Effect.gen(function* () {
  const snapshots = new Map([
    [first, yield* SubscriptionRef.make<SessionGroupsSnapshot>({ groups: [] })],
    [
      second,
      yield* SubscriptionRef.make<SessionGroupsSnapshot>({
        groups: [{ id: "second-group", name: "Second", threadIds: [] }],
      }),
    ],
  ]);
  const calls: Array<{ environmentId: EnvironmentId; input: SessionGroupsUpdate }> = [];
  const supervisors = new Map<EnvironmentId, EnvironmentSupervisor["Service"]>();
  for (const environmentId of [first, second]) {
    const client = {
      [WS_METHODS.sessionGroupsWatch]: () => SubscriptionRef.changes(snapshots.get(environmentId)!),
      [WS_METHODS.sessionGroupsUpdate]: (input: SessionGroupsUpdate) =>
        Effect.sync(() => {
          calls.push({ environmentId, input });
          return { groups: [] } satisfies SessionGroupsSnapshot;
        }),
    };
    supervisors.set(environmentId, {
      target: { environmentId },
      session: yield* SubscriptionRef.make(Option.some({ client } as unknown as RpcSession)),
    } as EnvironmentSupervisor["Service"]);
  }
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry, {
      run: (id, effect) =>
        Effect.provideService(effect, EnvironmentSupervisor, supervisors.get(id)!),
      followStream: (id, stream) =>
        Stream.provideService(stream, EnvironmentSupervisor, supervisors.get(id)!),
    } as EnvironmentRegistry["Service"]),
  );
  const atoms = createSessionGroupsAtoms(runtime);
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  return { ...atoms, registry, snapshots, supervisors, calls };
});

function observed(
  registry: AtomRegistry.AtomRegistry,
  atom: ReturnType<ReturnType<typeof createSessionGroupsAtoms>["sessionGroupsAtom"]>,
  predicate: (snapshot: SessionGroupsSnapshot) => boolean,
) {
  let resolve!: (snapshot: SessionGroupsSnapshot) => void;
  let reject!: (cause: unknown) => void;
  const pending = new Promise<SessionGroupsSnapshot>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  const unsubscribe = registry.subscribe(
    atom,
    (result) => {
      if (result._tag === "Failure") reject(result.cause);
      if (result._tag === "Success" && predicate(result.value)) resolve(result.value);
    },
    { immediate: true },
  );
  return pending.finally(unsubscribe);
}

describe("session groups state", () => {
  it.effect(
    "serializes one environment, permits independent environments, and rechecks queued grants",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness;
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const stopFirst = h.registry.mount(sessions(first));
          const stopSecond = h.registry.mount(sessions(second));
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              stopFirst();
              stopSecond();
            }),
          );
          h.registry.set(sessions(first), AsyncResult.success(grant(true)));
          h.registry.set(sessions(second), AsyncResult.success(grant(true)));
          const client = {
            [WS_METHODS.sessionGroupsUpdate]: (input: SessionGroupsUpdate) =>
              Effect.gen(function* () {
                h.calls.push({ environmentId: first, input });
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
                return { groups: [] } satisfies SessionGroupsSnapshot;
              }),
          };
          yield* SubscriptionRef.set(
            h.supervisors.get(first)!.session,
            Option.some({ client } as unknown as RpcSession),
          );
          const input = { type: "rename" as const, id: "work", name: "Renamed" };
          const active = h.updateSessionGroups.run(h.registry, { environmentId: first, input });
          yield* Deferred.await(entered);
          const queued = h.updateSessionGroups.run(h.registry, {
            environmentId: first,
            input: { type: "delete", id: "work" },
          });
          const independent = yield* Effect.promise(() =>
            h.updateSessionGroups.run(h.registry, { environmentId: second, input }),
          );
          expect(independent._tag).toBe("Success");
          expect(h.calls.map((call) => call.environmentId)).toEqual([first, second]);
          h.registry.set(sessions(first), AsyncResult.success(grant(false)));
          yield* Deferred.succeed(release, undefined);
          expect((yield* Effect.promise(() => active))._tag).toBe("Success");
          expect((yield* Effect.promise(() => queued))._tag).toBe("Failure");
          expect(h.calls).toHaveLength(2);
        }),
      ),
  );
  it.effect(
    "follows full snapshots independently per environment and replaces membership after reconnect",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness;
          const atom = h.sessionGroupsAtom(first);
          const unmount = h.registry.mount(atom);
          yield* Effect.addFinalizer(() => Effect.sync(unmount));
          const initial = yield* Effect.promise(() =>
            observed(h.registry, atom, (snapshot) => snapshot.groups.length === 0),
          );
          expect(initial.groups).toEqual([]);
          const other = yield* Effect.promise(() =>
            observed(h.registry, h.sessionGroupsAtom(second), () => true),
          );
          expect(other.groups[0]?.id).toBe("second-group");
          const update = {
            groups: [{ id: "work", name: "Work", threadIds: [ThreadId.make("thread")] }],
          };
          const sawUpdate = observed(
            h.registry,
            atom,
            (snapshot) => snapshot.groups[0]?.name === "Work",
          );
          yield* SubscriptionRef.set(h.snapshots.get(first)!, update);
          expect(yield* Effect.promise(() => sawUpdate)).toEqual(update);
          const replacement = { groups: [{ id: "work", name: "Renamed", threadIds: [] }] };
          const sawReconnect = observed(
            h.registry,
            atom,
            (snapshot) => snapshot.groups[0]?.name === "Renamed",
          );
          const replacementClient = {
            [WS_METHODS.sessionGroupsWatch]: () =>
              Stream.make(replacement).pipe(Stream.concat(Stream.never)),
          };
          yield* SubscriptionRef.set(
            h.supervisors.get(first)!.session,
            Option.some({ client: replacementClient } as unknown as RpcSession),
          );
          expect(yield* Effect.promise(() => sawReconnect)).toEqual(replacement);
        }),
      ),
  );

  it.effect(
    "uses the destination operate grant for availability and every mutation, including after revocation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness;
          const stopFirst = h.registry.mount(sessions(first));
          const stopSecond = h.registry.mount(sessions(second));
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              stopFirst();
              stopSecond();
            }),
          );
          h.registry.set(sessions(first), AsyncResult.success(grant(true)));
          h.registry.set(sessions(second), AsyncResult.success(grant(false)));
          expect(h.registry.get(h.updateSessionGroups.permissionAtom(first))).toBe(true);
          expect(h.registry.get(h.updateSessionGroups.permissionAtom(second))).toBe(false);
          const input = {
            type: "membership" as const,
            id: "work",
            threadId: ThreadId.make("thread"),
            member: true,
          };
          const denied = yield* Effect.promise(() =>
            h.updateSessionGroups.run(h.registry, { environmentId: second, input }),
          );
          expect(denied._tag).toBe("Failure");
          expect(h.calls).toEqual([]);
          const allowed = yield* Effect.promise(() =>
            h.updateSessionGroups.run(h.registry, { environmentId: first, input }),
          );
          expect(allowed._tag).toBe("Success");
          expect(h.calls).toEqual([{ environmentId: first, input }]);
          h.registry.set(sessions(first), AsyncResult.success(grant(false)));
          expect(h.registry.get(h.updateSessionGroups.permissionAtom(first))).toBe(false);
          const revoked = yield* Effect.promise(() =>
            h.updateSessionGroups.run(h.registry, {
              environmentId: first,
              input: { type: "delete", id: "work" },
            }),
          );
          expect(revoked._tag).toBe("Failure");
          expect(h.calls).toHaveLength(1);
        }),
      ),
  );
});
