import { EnvironmentId } from "@t3tools/contracts";
import { act, createElement, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createSessionGroupSelectionStore, type SessionGroupSelection } from "./selection";
import type { SessionGroupListScope } from "./list-scope";
import {
  useSessionGroupListScope,
  useSessionGroupScopeActions,
} from "./use-session-group-list-scope";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const savedSelection = { environmentId: local, groupId: "work" };
const savedScope = { environmentId: remote, projectKey: "old-project" };

describe("group scope transitions across compact and split roots", () => {
  let root: Root;
  let store: ReturnType<typeof createSessionGroupSelectionStore>;
  let latest: Record<string, ReturnType<typeof useSessionGroupListScope>>;
  let scope: SessionGroupListScope;
  let changeScope: (value: SessionGroupListScope) => void;
  let headerActions: ReturnType<typeof useSessionGroupScopeActions>;

  function Probe(props: {
    readonly name: string;
    readonly scope: SessionGroupListScope;
    readonly setScope: (
      value: SessionGroupListScope | ((current: SessionGroupListScope) => SessionGroupListScope),
    ) => void;
  }) {
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
    const state = useSessionGroupListScope({
      ...props.scope,
      selection: snapshot.selection,
      select: store.select,
      onEnvironmentChange: (environmentId) =>
        props.setScope((current) => ({ ...current, environmentId })),
      onProjectChange: (projectKey) => props.setScope((current) => ({ ...current, projectKey })),
    });
    useLayoutEffect(() => {
      latest[props.name] = state;
    });
    return null;
  }

  function Workspace() {
    const [current, setCurrent] = useState<SessionGroupListScope>(savedScope);
    const actions = useSessionGroupScopeActions({
      clearSelection: () => store.select(null),
      onEnvironmentChange: (environmentId) => setCurrent((scope) => ({ ...scope, environmentId })),
      onProjectChange: (projectKey) => setCurrent((scope) => ({ ...scope, projectKey })),
    });
    useLayoutEffect(() => {
      scope = current;
      changeScope = setCurrent;
      headerActions = actions;
    });
    return [
      createElement(Probe, {
        key: "compact",
        name: "compact",
        scope: current,
        setScope: setCurrent,
      }),
      createElement(Probe, { key: "split", name: "split", scope: current, setScope: setCurrent }),
    ];
  }

  beforeEach(async () => {
    // These hook probes render no DOM; ReactDOM only needs an event target.
    const document = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
    const container = {
      nodeType: 1,
      tagName: "DIV",
      namespaceURI: "http://www.w3.org/1999/xhtml",
      ownerDocument: document,
      addEventListener() {},
      removeEventListener() {},
    };
    vi.stubGlobal("document", document);
    vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    latest = {};
    store = createSessionGroupSelectionStore({
      load: async () => JSON.stringify(savedSelection),
      save: async () => {},
    });
    await store.load();
    root = createRoot(container as unknown as HTMLElement);
    await act(() => root.render(createElement(Workspace)));
  });

  afterEach(async () => {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it("preserves restored groups over saved scopes and same-group reselection in both roots", async () => {
    expect(latest.compact!.environmentId).toBe(local);
    expect(latest.split!.projectKey).toBeNull();
    await act(() => latest.compact!.selectGroup({ ...savedSelection }));
    expect(scope).toEqual({ environmentId: null, projectKey: null });
    expect(store.getSnapshot().selection).toEqual(savedSelection);
    expect(latest.split!.environmentId).toBe(local);
    await act(() => latest.split!.selectGroup(null));
    expect(store.getSnapshot().selection).toBeNull();
    expect(latest.compact!.environmentId).toBeNull();
    expect(latest.split!.projectKey).toBeNull();
  });

  it("clears the shared group when an external native/compact header changes scopes", async () => {
    await act(() => changeScope({ environmentId: local, projectKey: "new-project" }));
    expect(store.getSnapshot().selection).toBeNull();
    expect(latest.compact!.projectKey).toBe("new-project");
    expect(latest.split!.projectKey).toBe("new-project");
  });

  it("choosing another group resets both scopes and choosing a normal filter clears the group", async () => {
    const review: SessionGroupSelection = { environmentId: local, groupId: "review" };
    await act(() => latest.split!.selectGroup(review));
    expect(scope).toEqual({ environmentId: null, projectKey: null });
    expect(store.getSnapshot().selection).toEqual(review);
    expect(latest.compact!.environmentId).toBe(local);
    await act(() => latest.compact!.changeEnvironment(remote));
    expect(store.getSnapshot().selection).toBeNull();
    expect(latest.split!.environmentId).toBe(remote);
    await act(() => latest.split!.selectGroup(review));
    await act(() => latest.split!.changeProject("chosen-project"));
    expect(store.getSnapshot().selection).toBeNull();
    expect(latest.compact!.projectKey).toBe("chosen-project");
  });

  it.each(["environment", "project"] as const)(
    "the external header's All %s action clears a group when the stored scope is already null",
    async (kind) => {
      await act(() => latest.compact!.selectGroup({ ...savedSelection }));
      const before = scope;
      expect(before).toEqual({ environmentId: null, projectKey: null });
      await act(() =>
        kind === "environment"
          ? headerActions.changeEnvironment(null)
          : headerActions.changeProject(null),
      );
      expect(scope).toEqual(before);
      expect(store.getSnapshot().selection).toBeNull();
      expect(latest.compact!.environmentId).toBeNull();
      expect(latest.split!.projectKey).toBeNull();
    },
  );

  it.each(["environment", "project"] as const)(
    "the external header's same-value %s action replaces an overriding restored group",
    async (kind) => {
      expect(scope).toEqual(savedScope);
      expect(latest.compact!.environmentId).toBe(local);
      await act(() =>
        kind === "environment"
          ? headerActions.changeEnvironment(remote)
          : headerActions.changeProject(savedScope.projectKey),
      );
      expect(scope).toEqual(savedScope);
      expect(store.getSnapshot().selection).toBeNull();
      expect(latest.compact!.environmentId).toBe(remote);
      expect(latest.split!.projectKey).toBe(savedScope.projectKey);
    },
  );
});
