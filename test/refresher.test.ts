import { afterEach, describe, expect, it, vi } from "vitest";
import { validateCatalogPayload } from "../src/catalog-evidence";
import type {
  DiscoveryResult,
  DiscoveryTarget,
  ProviderInventory,
} from "../src/discover";
import {
  ACTIVATION_PROBE_MS,
  createRefresher,
  DEFAULT_REFRESH_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  loadPersisted,
  readOptions,
  readPersisted,
  REPLACEMENT_WAIT_MS,
  STORAGE_PREFIX,
  toPersisted,
  type HostEvent,
  type PersistedBinding,
  type RefresherHost,
} from "../src/refresher";
import {
  createStore,
  MIN_REFRESH_INTERVAL_MS,
  type Binding,
  type DiscoveryStore,
} from "../src/store";
import {
  createTransformState,
  eligibleTarget,
  servedBinding,
  type ProviderLike,
} from "../src/transform";

const COMPAT = "aisdk:@ai-sdk/openai-compatible";
const HERE = { directory: "/projects/a" };

function provider(
  id: string,
  settings: Record<string, unknown> = {
    baseURL: `http://${id}/v1`,
    apiKey: "settings-key",
  },
  extra: Partial<ProviderLike> = {},
): ProviderLike {
  return { id, package: COMPAT, settings, ...extra };
}

function inventory(
  ids: string[],
  completedAt = new Date().toISOString(),
): ProviderInventory {
  return {
    modelListAttempt: "ready",
    probeAttempt: "not-requested",
    models: ids.map((id) => ({ id })),
    completedAt,
  };
}

function deferred() {
  let resolve!: (value: DiscoveryResult) => void;
  const promise = new Promise<DiscoveryResult>((done) => (resolve = done));
  return { promise, resolve };
}

interface Harness {
  host: RefresherHost;
  providers: ProviderLike[];
  credentials: Map<string, { connection: string; key: string }>;
  reload: ReturnType<typeof vi.fn>;
  emitted: string[];
  persisted: Map<string, PersistedBinding>;
  listCalls: () => number;
  /** What the host's plugin list answers about this plugin. */
  pluginListed: boolean;
}

function harness(providers: ProviderLike[], location = HERE): Harness {
  const state = {
    providers,
    credentials: new Map<string, { connection: string; key: string }>(),
    reload: vi.fn(async () => {}),
    emitted: [] as string[],
    persisted: new Map<string, PersistedBinding>(),
    calls: 0,
    pluginListed: false,
  };
  const host: RefresherHost = {
    location,
    listProviders: async () => {
      state.calls += 1;
      return state.providers;
    },
    activeCredential: async (id) => state.credentials.get(id),
    reload: state.reload,
    pluginListed: async () => state.pluginListed,
    events: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<HostEvent>>(() => {}),
      }),
    }),
    emitUpdated: async (completedAt) => {
      state.emitted.push(completedAt);
    },
    emitStatus: async () => {},
    persist: async (key, value) => {
      state.persisted.set(key, value);
    },
  };
  return {
    host,
    get providers() {
      return state.providers;
    },
    set providers(value) {
      state.providers = value;
    },
    credentials: state.credentials,
    reload: state.reload,
    emitted: state.emitted,
    persisted: state.persisted,
    listCalls: () => state.calls,
    get pluginListed() {
      return state.pluginListed;
    },
    set pluginListed(value) {
      state.pluginListed = value;
    },
  };
}

function setup(
  h: Harness,
  discover: (
    target: DiscoveryTarget,
    signal: AbortSignal,
  ) => Promise<DiscoveryResult>,
  store: DiscoveryStore = createStore(),
  options = { timeoutMs: 15_000, refreshIntervalMs: 600_000 },
) {
  const state = createTransformState();
  state.recorded = new Set();
  const refresher = createRefresher({
    host: h.host,
    options,
    state,
    store,
    packageVersion: "2.0.0-test",
    discover,
    debounceMs: 0,
  });
  return { refresher, state, store };
}

async function settle(store: DiscoveryStore, h: Harness, id = "local") {
  const target = eligibleTarget(
    h.providers.find((entry) => entry.id === id)!,
    new Set(),
  )!;
  await store.settled(target.keys.key);
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
}

function keyOf(p: ProviderLike): string {
  return eligibleTarget(p, new Set())!.keys.key;
}

/** Seed a settings-credential binding as `loadPersisted` would. */
function seedFresh(
  store: DiscoveryStore,
  p: ProviderLike,
  completedAt: string,
  ids = ["m"],
): void {
  const { keys } = eligibleTarget(p, new Set())!;
  store.seed({
    key: keys.key,
    endpointKey: keys.endpointKey,
    providerID: p.id,
    credential: "settings",
    inventory: inventory(ids, completedAt),
  });
}

async function flush() {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("readOptions", () => {
  it("defaults both options", () => {
    expect(readOptions({})).toEqual({
      timeoutMs: DEFAULT_TIMEOUT_MS,
      refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS,
    });
  });

  it("clamps the timeout to 1 to 60 seconds", () => {
    expect(readOptions({ timeoutMs: 10 }).timeoutMs).toBe(1_000);
    expect(readOptions({ timeoutMs: 600_000 }).timeoutMs).toBe(60_000);
  });

  it("disables periodic refresh at 0 and floors other intervals at a minute", () => {
    expect(readOptions({ refreshIntervalMs: 0 }).refreshIntervalMs).toBe(0);
    expect(readOptions({ refreshIntervalMs: 5 }).refreshIntervalMs).toBe(
      MIN_REFRESH_INTERVAL_MS,
    );
  });

  it("ignores values that are not finite numbers", () => {
    expect(readOptions({ timeoutMs: "5000", refreshIntervalMs: null })).toEqual(
      readOptions({}),
    );
  });
});

describe("sync", () => {
  it("discovers a target, reloads once, and announces the update", async () => {
    const h = harness([provider("local")]);
    const discover = vi.fn(async (_target: DiscoveryTarget) => ({
      ok: true as const,
      inventory: inventory(["m"]),
    }));
    const { refresher, state, store } = setup(h, discover);
    await refresher.sync();
    await settle(store, h);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(discover.mock.calls[0][0]).toMatchObject({
      providerID: "local",
      apiKey: "settings-key",
    });
    expect(state.active.get("local")?.inventory.models).toEqual([{ id: "m" }]);
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(h.emitted).toHaveLength(1);
    expect(h.persisted.has(`${STORAGE_PREFIX}${keyOf(h.providers[0])}`)).toBe(
      true,
    );
  });

  it("does not rediscover or reload again while the inventory is fresh", async () => {
    const h = harness([provider("local")]);
    const discover = vi.fn(async () => ({
      ok: true as const,
      inventory: inventory(["m"]),
    }));
    const { refresher, store } = setup(h, discover);
    await refresher.sync();
    await settle(store, h);
    refresher.handleEvent({ type: "model.updated", location: HERE });
    await refresher.sync();
    await settle(store, h);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it("rediscovers a stale inventory", async () => {
    const h = harness([provider("local")]);
    const store = createStore();
    store.seed({
      key: keyOf(h.providers[0]),
      endpointKey: eligibleTarget(h.providers[0], new Set())!.keys.endpointKey,
      providerID: "local",
      credential: "settings",
      inventory: inventory(["old"], "2020-01-01T00:00:00.000Z"),
    });
    const discover = vi.fn(async () => ({
      ok: true as const,
      inventory: inventory(["new"]),
    }));
    const { refresher } = setup(h, discover, store);
    await refresher.sync();
    await settle(store, h);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(store.served(keyOf(h.providers[0]))?.inventory.models).toEqual([
      { id: "new" },
    ]);
  });

  it("does not retry a failing target on every trigger", async () => {
    const h = harness([provider("local")]);
    const discover = vi.fn(async () => ({
      ok: false as const,
      failure: "unreachable" as const,
      modelListAttempt: "unreachable" as const,
    }));
    const { refresher, store } = setup(h, discover);
    await refresher.sync();
    await settle(store, h);
    await refresher.sync();
    await settle(store, h);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(h.reload).not.toHaveBeenCalled();
  });

  it("uses the integration key when settings carry none", async () => {
    const h = harness([
      provider(
        "local",
        { baseURL: "http://local/v1" },
        { integrationID: "acme" },
      ),
    ]);
    h.credentials.set("acme", {
      connection: "credential:c1",
      key: "account-a",
    });
    const discover = vi.fn(async (_target: DiscoveryTarget) => ({
      ok: true as const,
      inventory: inventory(["m"]),
    }));
    const { refresher, store } = setup(h, discover);
    await refresher.sync();
    await settle(store, h);
    expect(discover.mock.calls[0][0]).toMatchObject({ apiKey: "account-a" });
    const persisted = [...h.persisted.values()][0];
    expect(persisted.credential).toMatch(/^integration:[0-9a-f]{64}$/);
    expect(JSON.stringify(persisted)).not.toContain("account-a");
  });

  it("drops the old account's models when the integration key changes", async () => {
    const h = harness([
      provider(
        "local",
        { baseURL: "http://local/v1" },
        { integrationID: "acme" },
      ),
    ]);
    h.credentials.set("acme", {
      connection: "credential:c1",
      key: "account-a",
    });
    const replacement = deferred();
    const discover = vi
      .fn<(target: DiscoveryTarget) => Promise<DiscoveryResult>>()
      .mockResolvedValueOnce({ ok: true, inventory: inventory(["a-model"]) })
      .mockReturnValueOnce(replacement.promise);
    const { refresher, state, store } = setup(h, discover);
    await refresher.sync();
    await settle(store, h);
    expect(state.active.get("local")?.inventory.models).toEqual([
      { id: "a-model" },
    ]);

    h.credentials.set("acme", {
      connection: "credential:c2",
      key: "account-b",
    });
    refresher.handleEvent({ type: "credential.updated" });
    await refresher.sync();
    expect(state.active.has("local")).toBe(false);
    expect(discover.mock.calls[1][0]).toMatchObject({ apiKey: "account-b" });

    replacement.resolve({
      ok: false,
      failure: "unauthorized",
      modelListAttempt: "http-error",
      httpStatus: 401,
    });
    await flush();
    expect(state.active.has("local")).toBe(false);
    expect(refresher.catalog().providers[0]?.lastGoodAt).toBeNull();
  });

  it("promotes a persisted integration binding without network when the account matches", async () => {
    const h = harness([
      provider(
        "local",
        { baseURL: "http://local/v1" },
        { integrationID: "acme" },
      ),
    ]);
    h.credentials.set("acme", {
      connection: "credential:c1",
      key: "account-a",
    });
    const discover = vi.fn(async () => ({
      ok: true as const,
      inventory: inventory(["m"]),
    }));
    const first = setup(h, discover);
    await first.refresher.sync();
    await settle(first.store, h);
    const persisted = [...h.persisted.entries()][0];

    const store = createStore();
    const seeded = readPersisted(persisted[0], persisted[1])!;
    store.seed(seeded);
    const second = setup(h, discover, store);
    const target = eligibleTarget(h.providers[0], new Set())!;
    expect(servedBinding(target, second.state)).toBeUndefined();
    await second.refresher.sync();
    expect(store.served(seeded.key)).toBeDefined();
    expect(servedBinding(target, second.state)?.key).toBe(seeded.key);
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it("keeps the previous credential when the lookup fails", async () => {
    const h = harness([
      provider(
        "local",
        { baseURL: "http://local/v1" },
        { integrationID: "acme" },
      ),
    ]);
    h.credentials.set("acme", {
      connection: "credential:c1",
      key: "account-a",
    });
    const discover = vi.fn(async (_target: DiscoveryTarget) => ({
      ok: true as const,
      inventory: inventory(["m"]),
    }));
    const { refresher, state, store } = setup(h, discover);
    await refresher.sync();
    await settle(store, h);
    const before = state.active.get("local");
    expect(before).toBeDefined();

    vi.spyOn(h.host, "activeCredential").mockRejectedValueOnce(
      new Error("credential store unavailable"),
    );
    await refresher.sync();
    await flush();
    expect(state.active.get("local")).toBe(before);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it("skips a target whose first credential lookup fails instead of discovering without a key", async () => {
    const h = harness([
      provider(
        "local",
        { baseURL: "http://local/v1" },
        { integrationID: "acme" },
      ),
    ]);
    vi.spyOn(h.host, "activeCredential").mockRejectedValueOnce(
      new Error("credential store unavailable"),
    );
    const discover = vi.fn(async () => ({
      ok: true as const,
      inventory: inventory(["m"]),
    }));
    const { refresher } = setup(h, discover);
    await refresher.sync();
    await flush();
    expect(discover).not.toHaveBeenCalled();
    expect(refresher.catalog().providers).toEqual([
      expect.objectContaining({
        id: "local",
        credentialSource: "unresolved",
        lastGoodAt: null,
        failure: null,
        models: [],
      }),
    ]);
  });
});

describe("updated event", () => {
  const NO_INTERVAL = { timeoutMs: 15_000, refreshIntervalMs: 0 };

  it("announces stored bindings after the first sync, once the reload has finished", async () => {
    const h = harness([provider("local")]);
    const store = createStore();
    seedFresh(store, h.providers[0], "2026-10-11T08:00:00.000Z");
    let finishReload!: () => void;
    h.reload.mockImplementationOnce(
      () => new Promise<void>((done) => (finishReload = done)),
    );
    const discover = vi.fn();
    const { refresher } = setup(h, discover, store, NO_INTERVAL);
    await refresher.sync();
    await flush();
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(h.emitted).toEqual([]);
    finishReload();
    await flush();
    expect(h.emitted).toEqual(["2026-10-11T08:00:00.000Z"]);
    expect(discover).not.toHaveBeenCalled();
  });

  it("announces the first sync even when it resolves no targets", async () => {
    const h = harness([]);
    const { refresher } = setup(h, vi.fn());
    await refresher.sync();
    await flush();
    expect(h.emitted).toHaveLength(1);
  });

  it("announces a later sync only when it changes the served targets", async () => {
    const h = harness([provider("local"), provider("other")]);
    const store = createStore();
    seedFresh(store, h.providers[0], "2026-10-11T08:00:00.000Z");
    seedFresh(store, h.providers[1], "2026-10-11T09:00:00.000Z");
    const { refresher } = setup(h, vi.fn(), store, NO_INTERVAL);
    await refresher.sync();
    await flush();
    await refresher.sync();
    await flush();
    expect(h.emitted).toEqual(["2026-10-11T09:00:00.000Z"]);

    h.providers = [h.providers[0]];
    await refresher.sync();
    await flush();
    expect(h.emitted).toEqual([
      "2026-10-11T09:00:00.000Z",
      "2026-10-11T08:00:00.000Z",
    ]);
    expect(refresher.catalog().providers.map((record) => record.id)).toEqual([
      "local",
    ]);
  });
});

describe("activation", () => {
  const ok = async (_target: DiscoveryTarget) => ({
    ok: true as const,
    inventory: inventory(["m"]),
  });
  const actualyze = (baseURL: string) =>
    provider(
      "actualyze",
      { baseURL, probe: "actualyze" },
      { integrationID: "actualyze" },
    );

  /** A harness whose `actualyze` target resolves to an integration key. */
  function started(providers: ProviderLike[], listed: boolean) {
    vi.useFakeTimers();
    const h = harness(providers);
    h.pluginListed = listed;
    h.credentials.set("actualyze", { connection: "env:K", key: "run-key" });
    const discover = vi.fn(ok);
    const s = setup(h, discover);
    s.refresher.start();
    return { h, discover, ...s };
  }

  it("reads no provider list before the host's activation ends, whatever triggers", async () => {
    const { h, discover, refresher } = started([provider("local")], false);
    await vi.advanceTimersByTimeAsync(100);
    refresher.handleEvent({ type: "provider.updated", location: HERE });
    refresher.handleEvent({ type: "config.updated", location: HERE });
    refresher.handleEvent({ type: "credential.updated" });
    await vi.advanceTimersByTimeAsync(100);
    expect(refresher.refresh()).toEqual({
      accepted: false,
      reason: "no-targets",
    });
    expect(h.listCalls()).toBe(0);
    expect(discover).not.toHaveBeenCalled();
    refresher.dispose();
  });

  it("discovers only the base URL the provider has once plugin.updated arrives", async () => {
    const configured = "http://staging.example/openai/v1";
    const { h, discover, refresher } = started(
      [actualyze("https://app.actualyze.ai/openai/v1")],
      false,
    );
    await vi.advanceTimersByTimeAsync(100);
    // The config provider plugin merges the configured settings at the end
    // of the activation.
    h.providers = [actualyze(configured)];
    refresher.handleEvent({ type: "plugin.updated", location: HERE });
    await vi.advanceTimersByTimeAsync(10);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(discover.mock.calls[0][0]).toMatchObject({
      baseURL: configured,
      apiKey: "run-key",
    });
    refresher.dispose();
  });

  it("ignores plugin.updated from another location or without one", async () => {
    const { h, refresher } = started([provider("local")], false);
    refresher.handleEvent({
      type: "plugin.updated",
      location: { directory: "/projects/b" },
    });
    refresher.handleEvent({ type: "plugin.updated" });
    await vi.advanceTimersByTimeAsync(ACTIVATION_PROBE_MS - 1);
    expect(h.listCalls()).toBe(0);
    refresher.dispose();
  });

  it("starts once the host's plugin list first has the plugin, without an event", async () => {
    const { h, discover, refresher } = started([provider("local")], false);
    await vi.advanceTimersByTimeAsync(ACTIVATION_PROBE_MS * 2);
    expect(h.listCalls()).toBe(0);
    h.pluginListed = true;
    await vi.advanceTimersByTimeAsync(ACTIVATION_PROBE_MS * 4);
    expect(h.listCalls()).toBe(1);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(refresher.catalog().providers[0]?.held).toBe(false);
    refresher.dispose();
  });

  it("does not count provider.updated during a first activation", async () => {
    const { h, refresher } = started([provider("local")], false);
    await vi.advanceTimersByTimeAsync(0);
    refresher.handleEvent({ type: "provider.updated", location: HERE });
    await vi.advanceTimersByTimeAsync(ACTIVATION_PROBE_MS - 1);
    expect(h.listCalls()).toBe(0);
    refresher.dispose();
  });

  describe("when the plugin list already has the plugin at start", () => {
    it("does not count provider.updated, which a credential change publishes mid-reload", async () => {
      const { h, refresher } = started([provider("local")], true);
      await vi.advanceTimersByTimeAsync(0);
      refresher.handleEvent({ type: "provider.updated", location: HERE });
      refresher.handleEvent({ type: "credential.switched" });
      await vi.advanceTimersByTimeAsync(REPLACEMENT_WAIT_MS - 1);
      expect(h.listCalls()).toBe(0);
      refresher.dispose();
    });

    it("starts on plugin.updated at this location", async () => {
      const { h, refresher } = started([provider("local")], true);
      await vi.advanceTimersByTimeAsync(0);
      refresher.handleEvent({ type: "plugin.updated", location: HERE });
      await vi.advanceTimersByTimeAsync(10);
      expect(h.listCalls()).toBe(1);
      refresher.dispose();
    });

    it("takes the plugin list alone as the end only after the replacement wait, and then holds discovery", async () => {
      const { h, discover, refresher } = started([provider("local")], true);
      await vi.advanceTimersByTimeAsync(REPLACEMENT_WAIT_MS - 1);
      expect(h.listCalls()).toBe(0);
      // The next read of the plugin list comes at most one capped wait later.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.listCalls()).toBe(1);
      expect(discover).not.toHaveBeenCalled();
      expect(refresher.catalog().providers[0]?.held).toBe(true);
      refresher.dispose();
    });
  });

  describe("when the plugin list read at start fails", () => {
    function failingFirstRead() {
      vi.useFakeTimers();
      const h = harness([provider("local")]);
      const reads = vi
        .spyOn(h.host, "pluginListed")
        .mockRejectedValueOnce(new Error("unavailable"));
      const discover = vi.fn(ok);
      const { refresher } = setup(h, discover);
      refresher.start();
      return { h, reads, discover, refresher };
    }

    it("does not count provider.updated", async () => {
      const { h, refresher } = failingFirstRead();
      h.pluginListed = true;
      await vi.advanceTimersByTimeAsync(0);
      refresher.handleEvent({ type: "provider.updated", location: HERE });
      await vi.advanceTimersByTimeAsync(10);
      expect(h.listCalls()).toBe(0);
      refresher.dispose();
    });

    it("starts fully once the list gains the plugin after a read without it", async () => {
      const { h, discover, refresher } = failingFirstRead();
      // The read after the failed one finds no entry: a first activation.
      await vi.advanceTimersByTimeAsync(ACTIVATION_PROBE_MS);
      expect(h.listCalls()).toBe(0);
      h.pluginListed = true;
      await vi.advanceTimersByTimeAsync(ACTIVATION_PROBE_MS * 2 + 10);
      expect(h.listCalls()).toBe(1);
      expect(discover).toHaveBeenCalledTimes(1);
      expect(refresher.catalog().providers[0]?.held).toBe(false);
      refresher.dispose();
    });

    it("waits out the replacement wait and holds discovery when the first answer already has the plugin", async () => {
      const { h, reads, discover, refresher } = failingFirstRead();
      h.pluginListed = true;
      await vi.advanceTimersByTimeAsync(REPLACEMENT_WAIT_MS - 1);
      expect(reads.mock.calls.length).toBeGreaterThan(2);
      expect(h.listCalls()).toBe(0);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.listCalls()).toBe(1);
      expect(discover).not.toHaveBeenCalled();
      refresher.dispose();
    });
  });

  it("stops reading the plugin list once disposed", async () => {
    const { h, refresher } = started([provider("local")], false);
    const reads = vi.spyOn(h.host, "pluginListed");
    await vi.advanceTimersByTimeAsync(0);
    refresher.dispose();
    const before = reads.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads.mock.calls.length).toBe(before);
  });

  it("keeps the periodic refresh waiting until activation", async () => {
    vi.useFakeTimers();
    const h = harness([provider("local")]);
    const { refresher } = setup(h, vi.fn(ok), createStore(), {
      timeoutMs: 15_000,
      refreshIntervalMs: 60_000,
    });
    refresher.start();
    await vi.advanceTimersByTimeAsync(60_000 * 2 + 10);
    expect(h.listCalls()).toBe(0);
    refresher.dispose();
  });
});

describe("while held", () => {
  const ok = async (_target: DiscoveryTarget) => ({
    ok: true as const,
    inventory: inventory(["fresh"]),
  });

  /**
   * A refresher that elapsed time alone activated: the host's plugin list
   * had the plugin at start and no plugin.updated came.
   */
  async function heldRefresher(
    h: Harness,
    store: DiscoveryStore = createStore(),
    refreshIntervalMs = 600_000,
  ) {
    h.pluginListed = true;
    const discover = vi.fn(ok);
    const s = setup(h, discover, store, {
      timeoutMs: 15_000,
      refreshIntervalMs,
    });
    s.refresher.start();
    await vi.advanceTimersByTimeAsync(REPLACEMENT_WAIT_MS + 5_000);
    expect(h.listCalls()).toBeGreaterThan(0);
    return { discover, ...s };
  }

  it("starts no discovery from a sync, the interval, a credential event, or RPC refresh", async () => {
    vi.useFakeTimers();
    const h = harness([
      provider("local"),
      provider(
        "via-acme",
        { baseURL: "http://acme/v1" },
        { integrationID: "acme" },
      ),
    ]);
    h.credentials.set("acme", { connection: "credential:c1", key: "k1" });
    const { discover, refresher } = await heldRefresher(
      h,
      createStore(),
      60_000,
    );

    await refresher.sync();
    let calls = h.listCalls();
    await vi.advanceTimersByTimeAsync(60_000 + 10);
    expect(h.listCalls()).toBeGreaterThan(calls);

    calls = h.listCalls();
    h.credentials.set("acme", { connection: "credential:c2", key: "k2" });
    refresher.handleEvent({
      type: "credential.switched",
      data: { integrationID: "acme", credentialID: "c2" },
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(h.listCalls()).toBeGreaterThan(calls);

    expect(refresher.refresh()).toEqual({ accepted: false, reason: "held" });
    expect(refresher.refresh("via-acme")).toEqual({
      accepted: false,
      reason: "held",
    });
    expect(discover).not.toHaveBeenCalled();
    refresher.dispose();
  });

  it("holds a keyless target too", async () => {
    vi.useFakeTimers();
    const h = harness([provider("free", { baseURL: "http://free/v1" })]);
    const { discover, refresher } = await heldRefresher(h);
    expect(refresher.catalog().providers[0]).toMatchObject({
      id: "free",
      credentialSource: "none",
      held: true,
    });
    expect(refresher.refresh("free")).toEqual({
      accepted: false,
      reason: "held",
    });
    expect(discover).not.toHaveBeenCalled();
    refresher.dispose();
  });

  it("reports every record held in a complete catalog", async () => {
    vi.useFakeTimers();
    const h = harness([provider("local")]);
    const { refresher } = await heldRefresher(h);
    const payload = refresher.catalog();
    expect(validateCatalogPayload(payload)).toBeDefined();
    expect(payload.status).toBe("complete");
    expect(payload.providers).toEqual([
      expect.objectContaining({
        id: "local",
        held: true,
        discovering: false,
        lastGoodAt: null,
      }),
    ]);
    refresher.dispose();
  });

  it("lifts on a located plugin.updated, and discovery runs", async () => {
    vi.useFakeTimers();
    const h = harness([provider("local")]);
    const store = createStore();
    const { discover, refresher, state } = await heldRefresher(h, store);
    refresher.handleEvent({ type: "plugin.updated" });
    refresher.handleEvent({
      type: "plugin.updated",
      location: { directory: "/projects/b" },
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(discover).not.toHaveBeenCalled();

    refresher.handleEvent({ type: "plugin.updated", location: HERE });
    await vi.advanceTimersByTimeAsync(10);
    await store.settled(keyOf(h.providers[0]));
    await vi.advanceTimersByTimeAsync(10);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(state.active.get("local")?.inventory.models).toEqual([
      { id: "fresh" },
    ]);
    expect(refresher.catalog().providers[0]?.held).toBe(false);
    refresher.dispose();
  });

  describe("when plugin.updated ends it", () => {
    const A = "http://a/v1";
    const B = "http://b/v1";
    const at = (baseURL: string) =>
      provider("local", { baseURL, apiKey: "settings-key" });
    const discovered = (discover: ReturnType<typeof vi.fn>): unknown[] =>
      discover.mock.calls.map(
        ([target]) => (target as DiscoveryTarget).baseURL,
      );

    it("refuses an RPC refresh that comes before the sync that follows it", async () => {
      vi.useFakeTimers();
      const h = harness([at(A)]);
      const { discover, refresher } = await heldRefresher(h);
      // The config provider plugin has applied B by the time OpenCode
      // reports that loading finished; the targets still hold A.
      h.providers = [at(B)];
      refresher.handleEvent({ type: "plugin.updated", location: HERE });
      expect(refresher.refresh()).toEqual({ accepted: false, reason: "held" });
      expect(refresher.catalog().providers[0]?.held).toBe(true);
      await vi.advanceTimersByTimeAsync(10);
      expect(discovered(discover)).toEqual([B]);
      expect(refresher.catalog().providers[0]?.held).toBe(false);
      refresher.dispose();
    });

    it("starts no job for a sync that read the provider list before it", async () => {
      vi.useFakeTimers();
      const h = harness([at(A)]);
      const { discover, refresher } = await heldRefresher(h);
      let resolveLookup: (value: undefined) => void = () => {};
      const lookup = vi
        .spyOn(h.host, "activeCredential")
        .mockImplementationOnce(
          () => new Promise((resolve) => (resolveLookup = resolve)),
        );
      refresher.handleEvent({ type: "credential.updated" });
      await vi.advanceTimersByTimeAsync(10);
      // That sync has read A and waits for the credential lookup.
      expect(lookup).toHaveBeenCalledTimes(1);
      h.providers = [at(B)];
      refresher.handleEvent({ type: "plugin.updated", location: HERE });
      await vi.advanceTimersByTimeAsync(10);
      resolveLookup(undefined);
      await vi.advanceTimersByTimeAsync(10);
      expect(discovered(discover)).toEqual([B]);
      refresher.dispose();
    });
  });

  describe("the active binding", () => {
    const at = (baseURL: string, probe?: string) =>
      provider("local", {
        baseURL,
        apiKey: "settings-key",
        ...(probe ? { probe } : {}),
      });

    it("is the stored binding of the current store key", async () => {
      vi.useFakeTimers();
      const store = createStore();
      const h = harness([at("http://a/v1")]);
      seedFresh(store, at("http://a/v1"), new Date().toISOString(), ["a"]);
      const { discover, refresher, state } = await heldRefresher(h, store);
      expect(state.active.get("local")).toBe(
        store.served(keyOf(at("http://a/v1"))),
      );
      expect(
        servedBinding(eligibleTarget(at("http://a/v1"), new Set())!, state),
      ).toBeDefined();
      expect(discover).not.toHaveBeenCalled();
      refresher.dispose();
    });

    it("is dropped when the target moves to an endpoint with no stored binding, and follows it back", async () => {
      vi.useFakeTimers();
      const store = createStore();
      const h = harness([at("http://a/v1")]);
      seedFresh(store, at("http://a/v1"), new Date().toISOString(), ["a"]);
      const { refresher, state } = await heldRefresher(h, store);
      expect(state.active.has("local")).toBe(true);

      h.providers = [at("http://b/v1")];
      await refresher.sync();
      expect(state.active.has("local")).toBe(false);

      seedFresh(store, at("http://b/v1"), new Date().toISOString(), ["b"]);
      await refresher.sync();
      expect(state.active.get("local")).toBe(
        store.served(keyOf(at("http://b/v1"))),
      );
      refresher.dispose();
    });

    it("is dropped on a probe-only change, which would otherwise keep serving the old probe's models", async () => {
      vi.useFakeTimers();
      const store = createStore();
      const h = harness([at("http://a/v1", "omlx")]);
      seedFresh(store, at("http://a/v1", "omlx"), new Date().toISOString());
      const { refresher, state } = await heldRefresher(h, store);
      const omlx = state.active.get("local");
      expect(omlx).toBeDefined();

      h.providers = [at("http://a/v1", "vllm")];
      await refresher.sync();
      expect(state.active.has("local")).toBe(false);

      h.providers = [at("http://a/v1", "omlx")];
      await refresher.sync();
      expect(state.active.get("local")).toBe(omlx);
      refresher.dispose();
    });
  });
});

describe("events", () => {
  it("triggers on matching or unlocated events and ignores other locations", async () => {
    vi.useFakeTimers();
    const h = harness([]);
    const { refresher } = setup(h, vi.fn());
    refresher.handleEvent({ type: "plugin.updated", location: HERE });
    await vi.runAllTimersAsync();
    expect(h.listCalls()).toBe(1);
    refresher.handleEvent({ type: "provider.updated", location: HERE });
    await vi.runAllTimersAsync();
    expect(h.listCalls()).toBe(2);
    refresher.handleEvent({ type: "credential.updated" });
    await vi.runAllTimersAsync();
    expect(h.listCalls()).toBe(3);
    refresher.handleEvent({
      type: "provider.updated",
      location: { directory: "/projects/b" },
    });
    refresher.handleEvent({
      type: "provider.updated",
      location: { ...HERE, workspaceID: "w" },
    });
    refresher.handleEvent({ type: "model.updated", location: HERE });
    await vi.runAllTimersAsync();
    expect(h.listCalls()).toBe(3);
  });

  it("stops serving every target of the switched integration on an unlocated credential switch", async () => {
    const h = harness([
      provider(
        "via-acme",
        { baseURL: "http://a/v1" },
        { integrationID: "acme" },
      ),
      provider(
        "via-other",
        { baseURL: "http://b/v1" },
        { integrationID: "other" },
      ),
      provider("with-key", undefined, { integrationID: "acme" }),
    ]);
    h.credentials.set("acme", { connection: "credential:c1", key: "k1" });
    h.credentials.set("other", { connection: "credential:c2", key: "k2" });
    const { refresher, state, store } = setup(h, async () => ({
      ok: true,
      inventory: inventory(["m"]),
    }));
    await refresher.sync();
    for (const p of h.providers) await settle(store, h, p.id);
    const viaAcme = state.active.get("via-acme")!;
    const reloads = h.reload.mock.calls.length;

    refresher.handleEvent({
      type: "credential.switched",
      data: { integrationID: "acme", credentialID: "c3" },
    });
    expect(state.active.has("via-acme")).toBe(false);
    expect(state.active.has("with-key")).toBe(false);
    expect(state.active.has("via-other")).toBe(true);
    // The entry stays for any other location that still uses that credential.
    expect(store.served(viaAcme.key)).toBe(viaAcme);
    await flush();
    expect(h.reload.mock.calls.length).toBeGreaterThan(reloads);
  });
});

describe("account switch during a probe edit", () => {
  it("drops the binding kept for the previous probe selection", async () => {
    const settings = (probe: string) => ({ baseURL: "http://local/v1", probe });
    const h = harness([
      provider("local", settings("omlx"), { integrationID: "acme" }),
    ]);
    h.credentials.set("acme", { connection: "credential:c1", key: "k1" });
    const pending = deferred();
    const discover = vi
      .fn<() => Promise<DiscoveryResult>>()
      .mockResolvedValueOnce({ ok: true, inventory: inventory(["m"]) })
      .mockReturnValue(pending.promise);
    const { refresher, state, store } = setup(h, discover);
    await refresher.sync();
    await settle(store, h);
    h.providers = [
      provider("local", settings("vllm"), { integrationID: "acme" }),
    ];
    await refresher.sync();
    expect(state.active.has("local")).toBe(true);

    refresher.handleEvent({
      type: "credential.switched",
      data: { integrationID: "acme", credentialID: "c2" },
    });
    expect(state.active.has("local")).toBe(false);
  });
});

describe("credential switch", () => {
  const viaAcme = () =>
    provider(
      "local",
      { baseURL: "http://local/v1" },
      { integrationID: "acme" },
    );
  const SWITCH: HostEvent = {
    type: "credential.switched",
    data: { integrationID: "acme", credentialID: "c2" },
  };

  async function boundToAccountA(discover: Parameters<typeof setup>[1]) {
    const h = harness([viaAcme()]);
    h.credentials.set("acme", {
      connection: "credential:c1",
      key: "account-a",
    });
    const s = setup(h, discover);
    await s.refresher.sync();
    await flush();
    const before = s.state.active.get("local")!;
    expect(before.inventory.models).toEqual([{ id: "a-model" }]);
    return { h, ...s, before, target: eligibleTarget(viaAcme(), new Set())! };
  }

  it("serves nothing when the credential lookup fails after a switch", async () => {
    const discover = vi.fn(async () => ({
      ok: true as const,
      inventory: inventory(["a-model"]),
    }));
    const { h, refresher, state, store, before, target } =
      await boundToAccountA(discover);
    vi.spyOn(h.host, "activeCredential").mockRejectedValue(
      new Error("credential store unavailable"),
    );

    refresher.handleEvent(SWITCH);
    await refresher.sync();
    await flush();
    expect(servedBinding(target, state)).toBeUndefined();
    expect(refresher.catalog().providers).toEqual([
      expect.objectContaining({
        id: "local",
        credentialSource: "unresolved",
        lastGoodAt: null,
        failure: null,
        models: [],
      }),
    ]);
    expect(discover).toHaveBeenCalledTimes(1);
    // The old account's entry stays for locations that still use it.
    expect(store.served(before.key)).toBe(before);
  });

  it("discovers and serves the new account once its credential resolves", async () => {
    const discover = vi
      .fn<(target: DiscoveryTarget) => Promise<DiscoveryResult>>()
      .mockResolvedValueOnce({ ok: true, inventory: inventory(["a-model"]) })
      .mockResolvedValueOnce({ ok: true, inventory: inventory(["b-model"]) });
    const { h, refresher, state, before, target } =
      await boundToAccountA(discover);

    h.credentials.set("acme", {
      connection: "credential:c2",
      key: "account-b",
    });
    refresher.handleEvent(SWITCH);
    await refresher.sync();
    await flush();
    expect(discover).toHaveBeenCalledTimes(2);
    expect(discover.mock.calls[1][0]).toMatchObject({ apiKey: "account-b" });
    const served = servedBinding(target, state);
    expect(served?.inventory.models).toEqual([{ id: "b-model" }]);
    expect(served?.key).not.toBe(before.key);
  });

  it("does not serve the previous account when a switch lands during a credential lookup", async () => {
    const discover = vi.fn(async () => ({
      ok: true as const,
      inventory: inventory(["a-model"]),
    }));
    const { h, refresher, state, target } = await boundToAccountA(discover);
    let finishLookup!: (credential: {
      connection: string;
      key: string;
    }) => void;
    vi.spyOn(h.host, "activeCredential")
      .mockRejectedValue(new Error("credential store unavailable"))
      .mockImplementationOnce(
        () => new Promise((done) => (finishLookup = done)),
      );
    const pending = refresher.sync();
    await flush();

    refresher.handleEvent(SWITCH);
    finishLookup({ connection: "credential:c1", key: "account-a" });
    await pending;
    await flush();
    expect(servedBinding(target, state)).toBeUndefined();
    expect(refresher.catalog().providers).toEqual([
      expect.objectContaining({
        id: "local",
        credentialSource: "unresolved",
        lastGoodAt: null,
        failure: null,
        models: [],
      }),
    ]);
  });

  it("aborts the old-credential job when this location was its only subscriber", async () => {
    const h = harness([viaAcme()]);
    h.credentials.set("acme", {
      connection: "credential:c1",
      key: "account-a",
    });
    const signals: AbortSignal[] = [];
    const { refresher } = setup(h, (_target, signal) => {
      signals.push(signal);
      return deferred().promise;
    });
    await refresher.sync();
    refresher.handleEvent(SWITCH);
    expect(signals[0].aborted).toBe(true);
  });

  it("ignores an old-credential job that completes after a switch while another location keeps it", async () => {
    const store = createStore();
    const oldJob = deferred();
    const signals: AbortSignal[] = [];
    const discover = vi.fn((target: DiscoveryTarget, signal: AbortSignal) => {
      signals.push(signal);
      return target.apiKey === "account-a"
        ? oldJob.promise
        : deferred().promise;
    });
    const a = harness([viaAcme()]);
    const b = harness([viaAcme()], { directory: "/projects/b" });
    for (const h of [a, b])
      h.credentials.set("acme", {
        connection: "credential:c1",
        key: "account-a",
      });
    const first = setup(a, discover, store);
    const second = setup(b, discover, store);
    await first.refresher.sync();
    await second.refresher.sync();
    expect(discover).toHaveBeenCalledTimes(1);

    a.credentials.set("acme", {
      connection: "credential:c2",
      key: "account-b",
    });
    first.refresher.handleEvent(SWITCH);
    await first.refresher.sync();
    expect(signals[0].aborted).toBe(false);

    oldJob.resolve({ ok: true, inventory: inventory(["a-model"]) });
    await flush();
    const target = eligibleTarget(viaAcme(), new Set())!;
    expect(servedBinding(target, first.state)).toBeUndefined();
    expect(a.reload).not.toHaveBeenCalled();
    expect(servedBinding(target, second.state)?.inventory.models).toEqual([
      { id: "a-model" },
    ]);
  });
});

describe("credential precedence with settings.apiKey", () => {
  // Inference uses the integration's active connection before
  // `settings.apiKey`, so discovery must use the same key.
  const withSettingsKey = () =>
    provider(
      "local",
      { baseURL: "http://local/v1", apiKey: "settings-a" },
      { integrationID: "acme" },
    );
  const SWITCH: HostEvent = {
    type: "credential.switched",
    data: { integrationID: "acme", credentialID: "c1" },
  };
  const CONNECTED_B = { connection: "credential:c1", key: "connected-b" };

  function discoverByKey() {
    return vi.fn(async (target: DiscoveryTarget) => ({
      ok: true as const,
      inventory: inventory([`via-${target.apiKey}`]),
    }));
  }

  it("discovers with the connected key instead of settings.apiKey", async () => {
    const h = harness([withSettingsKey()]);
    h.credentials.set("acme", CONNECTED_B);
    const discover = discoverByKey();
    const { refresher, state } = setup(h, discover);
    await refresher.sync();
    await flush();
    expect(discover).toHaveBeenCalledTimes(1);
    expect(discover.mock.calls[0][0]).toMatchObject({ apiKey: "connected-b" });
    const served = servedBinding(
      eligibleTarget(withSettingsKey(), new Set())!,
      state,
    );
    expect(served?.inventory.models).toEqual([{ id: "via-connected-b" }]);
    expect(served?.credential).toMatch(/^integration:/);
  });

  it("falls back to settings.apiKey once the connection is removed", async () => {
    const h = harness([withSettingsKey()]);
    h.credentials.set("acme", CONNECTED_B);
    const discover = discoverByKey();
    const { refresher, state } = setup(h, discover);
    await refresher.sync();
    await flush();

    h.credentials.delete("acme");
    refresher.handleEvent({
      type: "credential.switched",
      data: { integrationID: "acme", credentialID: null },
    });
    expect(state.active.has("local")).toBe(false);
    await refresher.sync();
    await flush();
    expect(discover).toHaveBeenCalledTimes(2);
    expect(discover.mock.calls[1][0]).toMatchObject({ apiKey: "settings-a" });
    expect(state.active.get("local")?.inventory.models).toEqual([
      { id: "via-settings-a" },
    ]);
  });

  it("uses settings.apiKey when the first lookup fails", async () => {
    const h = harness([withSettingsKey()]);
    vi.spyOn(h.host, "activeCredential").mockRejectedValueOnce(
      new Error("credential store unavailable"),
    );
    const discover = discoverByKey();
    const { refresher, state } = setup(h, discover);
    await refresher.sync();
    await flush();
    expect(discover.mock.calls[0][0]).toMatchObject({ apiKey: "settings-a" });
    expect(state.active.get("local")?.credential).toBe("settings");
  });

  it("keeps the connected key when a later lookup fails", async () => {
    const h = harness([withSettingsKey()]);
    h.credentials.set("acme", CONNECTED_B);
    const discover = discoverByKey();
    const { refresher, state } = setup(h, discover);
    await refresher.sync();
    await flush();
    const before = state.active.get("local");

    vi.spyOn(h.host, "activeCredential").mockRejectedValueOnce(
      new Error("credential store unavailable"),
    );
    await refresher.sync();
    await flush();
    expect(discover).toHaveBeenCalledTimes(1);
    expect(state.active.get("local")).toBe(before);
  });

  it("revokes a settings.apiKey resolution when a key is connected, then discovers with it", async () => {
    const h = harness([withSettingsKey()]);
    const discover = discoverByKey();
    const { refresher, state } = setup(h, discover);
    await refresher.sync();
    await flush();
    expect(state.active.get("local")?.credential).toBe("settings");

    h.credentials.set("acme", CONNECTED_B);
    refresher.handleEvent(SWITCH);
    expect(state.active.has("local")).toBe(false);
    await refresher.sync();
    await flush();
    expect(discover.mock.calls[1][0]).toMatchObject({ apiKey: "connected-b" });
    expect(state.active.get("local")?.inventory.models).toEqual([
      { id: "via-connected-b" },
    ]);
  });

  it("does not keep a settings.apiKey resolution from a lookup that a connection overtook", async () => {
    const h = harness([withSettingsKey()]);
    let finishLookup!: (credential: undefined) => void;
    vi.spyOn(h.host, "activeCredential").mockImplementationOnce(
      () => new Promise((done) => (finishLookup = done)),
    );
    const discover = discoverByKey();
    const { refresher, state } = setup(h, discover);
    const pending = refresher.sync();
    await flush();

    h.credentials.set("acme", CONNECTED_B);
    refresher.handleEvent(SWITCH);
    finishLookup(undefined);
    await pending;
    await flush();
    expect(
      discover.mock.calls.every(([target]) => target.apiKey !== "settings-a"),
    ).toBe(true);
    expect(state.active.get("local")?.credential ?? "none").not.toBe(
      "settings",
    );
  });

  it("does not serve a persisted settings.apiKey binding while a key is connected", async () => {
    const h = harness([withSettingsKey()]);
    h.credentials.set("acme", CONNECTED_B);
    const store = createStore();
    seedFresh(store, withSettingsKey(), new Date().toISOString(), ["stale"]);
    const discover = discoverByKey();
    const { refresher, state } = setup(h, discover, store);
    await refresher.sync();
    await flush();
    expect(discover.mock.calls[0][0]).toMatchObject({ apiKey: "connected-b" });
    expect(state.active.get("local")?.inventory.models).toEqual([
      { id: "via-connected-b" },
    ]);
  });
});

describe("startup with a persisted binding", () => {
  it("serves it after the first sync without discovery", async () => {
    const h = harness([provider("local")]);
    const store = createStore();
    seedFresh(store, h.providers[0], new Date().toISOString(), ["stored"]);
    const discover = vi.fn();
    const { refresher, state } = setup(h, discover, store);
    const target = eligibleTarget(h.providers[0], new Set())!;
    expect(servedBinding(target, state)).toBeUndefined();

    await refresher.sync();
    expect(servedBinding(target, state)?.inventory.models).toEqual([
      { id: "stored" },
    ]);
    expect(h.listCalls()).toBe(1);
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(discover).not.toHaveBeenCalled();
  });
});

describe("shared store across locations", () => {
  it("keeps a shared job alive when one location unloads mid-discovery", async () => {
    const store = createStore();
    const job = deferred();
    const discover = vi.fn(() => job.promise);
    const a = harness([provider("local")]);
    const b = harness([provider("local")], { directory: "/projects/b" });
    const first = setup(a, discover, store);
    const second = setup(b, discover, store);
    await first.refresher.sync();
    await second.refresher.sync();
    first.refresher.dispose();
    job.resolve({ ok: true, inventory: inventory(["m"]) });
    await settle(store, b);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(second.state.active.get("local")).toBeDefined();
    expect(b.reload).toHaveBeenCalledTimes(1);
    expect(a.reload).not.toHaveBeenCalled();
  });

  it("discovers separately when two locations point one provider ID at different endpoints", async () => {
    const store = createStore();
    const discover = vi.fn(async (target: DiscoveryTarget) => ({
      ok: true as const,
      inventory: inventory([`from-${new URL(target.baseURL).hostname}`]),
    }));
    const a = harness([provider("local", { baseURL: "http://a/v1" })]);
    const b = harness([provider("local", { baseURL: "http://b/v1" })], {
      directory: "/projects/b",
    });
    const first = setup(a, discover, store);
    const second = setup(b, discover, store);
    await first.refresher.sync();
    await second.refresher.sync();
    await settle(store, a);
    await settle(store, b);
    expect(discover).toHaveBeenCalledTimes(2);
    expect(first.state.active.get("local")?.inventory.models).toEqual([
      { id: "from-a" },
    ]);
    expect(second.state.active.get("local")?.inventory.models).toEqual([
      { id: "from-b" },
    ]);
  });

  describe("when two locations reach one endpoint with different integration credentials", () => {
    const shared = () =>
      provider(
        "local",
        { baseURL: "http://local/v1", probe: "auto" },
        { integrationID: "acme" },
      );

    function twoLocations() {
      const store = createStore();
      const a = harness([shared()]);
      const b = harness([shared()], { directory: "/projects/b" });
      a.credentials.set("acme", { connection: "env:ACME_KEY_A", key: "key-a" });
      b.credentials.set("acme", { connection: "env:ACME_KEY_B", key: "key-b" });
      const jobs = new Map<
        string,
        { signal: AbortSignal; job: ReturnType<typeof deferred> }
      >();
      const discover = vi.fn((target: DiscoveryTarget, signal: AbortSignal) => {
        const job = deferred();
        jobs.set(target.apiKey!, { signal, job });
        return job.promise;
      });
      return {
        a,
        b,
        store,
        jobs,
        discover,
        first: setup(a, discover, store),
        second: setup(b, discover, store),
        target: eligibleTarget(shared(), new Set())!,
      };
    }

    it("runs one job per credential without either aborting the other", async () => {
      const { first, second, jobs, discover } = twoLocations();
      await first.refresher.sync();
      await second.refresher.sync();
      expect(discover).toHaveBeenCalledTimes(2);
      expect([...jobs.keys()].sort()).toEqual(["key-a", "key-b"]);
      expect(jobs.get("key-a")!.signal.aborted).toBe(false);
      expect(jobs.get("key-b")!.signal.aborted).toBe(false);
    });

    it("serves each location only the inventory from its own credential", async () => {
      const { first, second, jobs, target } = twoLocations();
      await first.refresher.sync();
      await second.refresher.sync();
      jobs.get("key-a")!.job.resolve({
        ok: true,
        inventory: inventory(["account-a-model"]),
      });
      await flush();
      expect(servedBinding(target, second.state)).toBeUndefined();

      jobs.get("key-b")!.job.resolve({
        ok: true,
        inventory: inventory(["account-b-model"]),
      });
      await flush();
      expect(servedBinding(target, first.state)?.inventory.models).toEqual([
        { id: "account-a-model" },
      ]);
      expect(servedBinding(target, second.state)?.inventory.models).toEqual([
        { id: "account-b-model" },
      ]);
    });

    it("keeps each location's binding through the other's later syncs", async () => {
      const { first, second, jobs, discover } = twoLocations();
      await first.refresher.sync();
      jobs.get("key-a")!.job.resolve({
        ok: true,
        inventory: inventory(["account-a-model"]),
      });
      await flush();
      const bound = first.state.active.get("local")!;

      await second.refresher.sync();
      await second.refresher.sync();
      expect(first.store.served(bound.key)).toBe(bound);
      expect(first.state.active.get("local")).toBe(bound);
      expect(discover).toHaveBeenCalledTimes(2);
    });

    it("persists the two inventories under different keys", async () => {
      const { a, b, first, second, jobs } = twoLocations();
      await first.refresher.sync();
      await second.refresher.sync();
      for (const [key, { job }] of jobs)
        job.resolve({ ok: true, inventory: inventory([`from-${key}`]) });
      await flush();
      const [keyA] = [...a.persisted.keys()];
      const [keyB] = [...b.persisted.keys()];
      expect(keyA).toBe(
        `${STORAGE_PREFIX}${first.state.active.get("local")!.key}`,
      );
      expect(keyB).toBe(
        `${STORAGE_PREFIX}${second.state.active.get("local")!.key}`,
      );
      expect(keyA).not.toBe(keyB);
    });
  });
});

describe("refresh", () => {
  it("joins an in-flight job, then enforces the minimum interval", async () => {
    let now = 1_000_000;
    const store = createStore(() => now);
    const job = deferred();
    const discover = vi.fn(() => job.promise);
    const h = harness([provider("local")]);
    const { refresher } = setup(h, discover, store);
    await refresher.sync();
    expect(refresher.refresh("local")).toEqual({ accepted: true });
    job.resolve({ ok: true, inventory: inventory(["m"]) });
    await settle(store, h);
    expect(refresher.refresh("local")).toEqual({
      accepted: false,
      reason: "throttled",
    });
    now += MIN_REFRESH_INTERVAL_MS;
    expect(refresher.refresh()).toEqual({ accepted: true });
    await settle(store, h);
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("rejects an unknown provider as having no targets", async () => {
    const h = harness([provider("local")]);
    const { refresher } = setup(
      h,
      vi.fn(() => deferred().promise),
    );
    await refresher.sync();
    expect(refresher.refresh("other")).toEqual({
      accepted: false,
      reason: "no-targets",
    });
  });

  it("reports no targets when no provider is a discovery target", async () => {
    const h = harness([]);
    const { refresher } = setup(h, vi.fn());
    await refresher.sync();
    expect(refresher.refresh()).toEqual({
      accepted: false,
      reason: "no-targets",
    });
  });
});

describe("catalog", () => {
  it("reports pending, running, and complete states that validate", async () => {
    const h = harness([provider("local")]);
    const job = deferred();
    const { refresher, store } = setup(h, () => job.promise);
    expect(refresher.catalog()).toMatchObject({ status: "pending" });
    await refresher.sync();
    const running = refresher.catalog();
    expect(validateCatalogPayload(running)).toBeDefined();
    expect(running.status).toBe("running");
    job.resolve({ ok: true, inventory: inventory(["m"]) });
    await settle(store, h);
    const complete = refresher.catalog();
    expect(validateCatalogPayload(complete)).toBeDefined();
    expect(complete).toMatchObject({
      status: "complete",
      packageVersion: "2.0.0-test",
    });
  });

  it("stays pending while the first sync cannot list providers", async () => {
    const h = harness([provider("local")]);
    vi.spyOn(h.host, "listProviders").mockRejectedValueOnce(new Error("down"));
    const { refresher } = setup(h, vi.fn());
    await refresher.sync();
    await flush();
    expect(refresher.catalog()).toMatchObject({
      status: "pending",
      providers: [],
    });
    expect(h.emitted).toEqual([]);
  });

  it("is complete as of the newest stored inventory when every target is served without a job", async () => {
    const h = harness([provider("local"), provider("other")]);
    const store = createStore();
    seedFresh(store, h.providers[0], "2026-10-11T08:00:00.000Z");
    seedFresh(store, h.providers[1], "2026-10-11T09:00:00.000Z");
    const discover = vi.fn();
    const { refresher } = setup(h, discover, store, {
      timeoutMs: 15_000,
      refreshIntervalMs: 0,
    });
    await refresher.sync();
    const payload = refresher.catalog();
    expect(validateCatalogPayload(payload)).toBeDefined();
    expect(payload).toMatchObject({
      status: "complete",
      completedAt: "2026-10-11T09:00:00.000Z",
    });
    expect(payload).not.toHaveProperty("startedAt");
    expect(payload.providers.map((record) => record.id).sort()).toEqual([
      "local",
      "other",
    ]);
    expect(discover).not.toHaveBeenCalled();
  });

  it("is complete as of the first sync when it resolves no targets", async () => {
    const h = harness([]);
    const { refresher } = setup(h, vi.fn());
    const before = new Date().toISOString();
    await refresher.sync();
    const payload = refresher.catalog();
    expect(validateCatalogPayload(payload)).toBeDefined();
    expect(payload.status).toBe("complete");
    expect(payload.completedAt! >= before).toBe(true);
  });

  it("keeps the last good inventory next to the latest failure", async () => {
    let now = 1_000_000;
    const store = createStore(() => now);
    const discover = vi
      .fn<() => Promise<DiscoveryResult>>()
      .mockResolvedValueOnce({ ok: true, inventory: inventory(["m"]) })
      .mockResolvedValueOnce({
        ok: false,
        failure: "unreachable",
        modelListAttempt: "unreachable",
      });
    const h = harness([provider("local")]);
    const { refresher } = setup(h, discover, store);
    await refresher.sync();
    await settle(store, h);
    now += MIN_REFRESH_INTERVAL_MS;
    refresher.refresh("local");
    await settle(store, h);
    const [record] = refresher.catalog().providers;
    expect(record.lastGoodAt).not.toBeNull();
    expect(record.failure).toMatchObject({ kind: "unreachable" });
    expect(record.modelListAttempt).toBe("ready");
  });

  it("never exposes credentials or the configured URL path", async () => {
    const h = harness([
      provider("local", {
        baseURL: "http://user:pw@local:8000/private/v1?token=t",
        apiKey: "settings-key",
      }),
    ]);
    const { refresher, store } = setup(h, async () => ({
      ok: true,
      inventory: inventory(["m"]),
    }));
    await refresher.sync();
    await settle(store, h);
    const payload = JSON.stringify(refresher.catalog());
    expect(payload).not.toMatch(/settings-key|pw|private|token/);
    expect(payload).toContain("http://local:8000");
  });
});

describe("persistence", () => {
  const binding: Binding = {
    key: "a".repeat(64),
    endpointKey: "b".repeat(64),
    providerID: "local",
    credential: "settings",
    inventory: inventory(["m"], "2026-01-01T00:00:00.000Z"),
  };

  it("round-trips a binding", () => {
    const stored = JSON.parse(JSON.stringify(toPersisted(binding))) as unknown;
    expect(readPersisted(`${STORAGE_PREFIX}${binding.key}`, stored)).toEqual(
      binding,
    );
  });

  it.each([
    ["a mismatched storage key", `${STORAGE_PREFIX}${"c".repeat(64)}`, {}],
    ["an unknown version", undefined, { version: 2 }],
    ["a raw credential", undefined, { credential: "sk-live-123" }],
    [
      "a malformed inventory",
      undefined,
      { inventory: { models: "x", completedAt: "now" } },
    ],
  ])("rejects %s", (_label, storageKey, change) => {
    expect(
      readPersisted(storageKey ?? `${STORAGE_PREFIX}${binding.key}`, {
        ...toPersisted(binding),
        ...change,
      }),
    ).toBeUndefined();
  });

  it("seeds valid entries and removes malformed ones", async () => {
    const removed: string[] = [];
    const store = createStore();
    await loadPersisted(
      {
        scan: async () => ({
          entries: [
            {
              key: `${STORAGE_PREFIX}${binding.key}`,
              value: toPersisted(binding),
            },
            { key: `${STORAGE_PREFIX}junk`, value: { version: 1 } },
          ],
        }),
        remove: async (key) => {
          removed.push(key);
        },
      },
      store,
    );
    expect(store.served(binding.key)).toBeDefined();
    expect(removed).toEqual([`${STORAGE_PREFIX}junk`]);
  });
});
