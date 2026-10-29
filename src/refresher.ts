/**
 * Per-instance discovery driver. It finds this location's targets, keeps
 * the instance subscribed to their store entries, starts or joins jobs,
 * reloads the model catalog when a binding changes, and builds the RPC
 * catalog payload.
 *
 * Triggers (debounced): the end of the host's plugin activation,
 * `plugin.updated`, `provider.updated`, `config.updated`,
 * `integration.updated`, `credential.updated`, `credential.switched`, the
 * periodic refresh, and RPC `refresh`. Events pass when they carry no
 * location or this instance's location; `credential.switched` is published
 * without one. A reload publishes only `model.updated`, which is not a
 * trigger, so a reload cannot trigger itself.
 *
 * No trigger runs a sync before the host has finished the plugin activation
 * that started this instance. Until then the provider list holds only the
 * plugins set up so far: the config provider plugin, which merges
 * `providers.<id>.settings` over plugin records, runs after every external
 * plugin, so a target could still carry a base URL that config replaces,
 * and discovery would send its key there. The end of the activation is a
 * located `plugin.updated`, or the plugin list rule in `watchActivation`.
 * `provider.updated` never counts: the host also publishes it for a
 * credential or integration change, from a read of the half-built list.
 *
 * Catalog records are kept per provider ID in a map that outlives each
 * sync's resolved targets, so an eligible provider keeps its record through
 * a credential switch and a failed credential lookup. Serving still goes
 * only through the active binding of a resolved target.
 */
import { randomUUID } from "node:crypto";
import {
  CATALOG_SCHEMA_VERSION,
  MAX_MODELS_PER_PROVIDER,
  isBoundedString,
  isProviderFailure,
  knownScalar,
  sanitizeEndpointOrigin,
  unknownScalar,
  validateCatalogPayload,
  type BuiltInState,
  type CatalogModelRecord,
  type CatalogPayload,
  type CatalogProviderRecord,
  type CredentialSource,
  type ProviderFailure,
} from "./catalog-evidence";
import { ACTUALYZE_PROBE_ID, ACTUALYZE_PROVIDER_ID } from "./constants";
import {
  discoverProvider,
  normalizeBaseURL,
  preExistingRecord,
  sanitizeProbeMeta,
  type DiscoveryResult,
  type DiscoveryTarget,
  type InventoryModel,
  type ProviderInventory,
} from "./discover";
import { toProbeKey } from "./probes/index";
import type { ProbeAttempt } from "./catalog-evidence";
import type { RefreshOutput } from "./rpc";
import {
  credentialKeys,
  fingerprint,
  MIN_REFRESH_INTERVAL_MS,
  type Binding,
  type CredentialFingerprint,
  type DiscoveryStore,
  type StoreUpdate,
  type Subscriber,
} from "./store";
import {
  eligibleTarget,
  servedBinding,
  type EligibleTarget,
  type ProviderLike,
  type TransformState,
} from "./transform";

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_REFRESH_INTERVAL_MS = 600_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 86_400_000;
const DEBOUNCE_MS = 50;
const EVENT_RETRY_MS = 1_000;
const EVENT_RETRY_MAX_MS = 30_000;
/** First read of the host's plugin list after the one at start; the wait doubles from here. */
export const ACTIVATION_PROBE_MS = 500;
const ACTIVATION_PROBE_MAX_MS = 5_000;
/**
 * How long after start an instance waits for `plugin.updated` when the first
 * read of the plugin list that answered already had an entry for this
 * plugin, before such an entry alone counts as the end of its activation.
 * The entry may belong to the instance this one replaces, so this rule rests
 * on elapsed time only.
 */
export const REPLACEMENT_WAIT_MS = 30_000;

export const STORAGE_PREFIX = "binding/";
const MAX_PERSISTED_BINDINGS = 128;

export const TRIGGER_EVENTS: ReadonlySet<string> = new Set([
  "plugin.updated",
  "provider.updated",
  "config.updated",
  "integration.updated",
  "credential.updated",
  "credential.switched",
]);

export interface RefresherOptions {
  readonly timeoutMs: number;
  /** 0 disables periodic refresh. */
  readonly refreshIntervalMs: number;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** Read plugin options, clamping each to its supported range. */
export function readOptions(
  options: Readonly<Record<string, unknown>> | undefined,
): RefresherOptions {
  const timeout = finiteNumber(options?.timeoutMs);
  const interval = finiteNumber(options?.refreshIntervalMs);
  return {
    timeoutMs:
      timeout === undefined
        ? DEFAULT_TIMEOUT_MS
        : Math.min(
            MAX_TIMEOUT_MS,
            Math.max(MIN_TIMEOUT_MS, Math.round(timeout)),
          ),
    refreshIntervalMs:
      interval === undefined
        ? DEFAULT_REFRESH_INTERVAL_MS
        : interval <= 0
          ? 0
          : Math.min(
              MAX_INTERVAL_MS,
              Math.max(MIN_INTERVAL_MS, Math.round(interval)),
            ),
  };
}

export interface LocationLike {
  readonly directory: string;
  readonly workspaceID?: string;
}

export interface HostEvent {
  readonly type: string;
  readonly location?: LocationLike;
  readonly data?: unknown;
}

export interface ActiveCredential {
  /** Stable connection identity, such as `credential:<id>` or `env:<name>`. */
  readonly connection: string;
  readonly key: string;
}

/** The host capabilities the refresher uses; `server.ts` adapts the plugin context. */
export interface RefresherHost {
  readonly location: LocationLike;
  listProviders(): Promise<readonly ProviderLike[]>;
  /** The active key credential for an integration, if any. */
  activeCredential(
    integrationID: string,
  ): Promise<ActiveCredential | undefined>;
  reload(): Promise<void>;
  /**
   * Whether the host's plugin list has an entry for this plugin, in any
   * state. The host replaces that list only once an activation has set up
   * every plugin.
   */
  pluginListed(): Promise<boolean>;
  events(signal: AbortSignal): AsyncIterable<HostEvent>;
  emitUpdated(completedAt: string): Promise<void>;
  /** Publish the RPC `status` event. */
  emitStatus(at: string): Promise<void>;
  persist(key: string, value: PersistedBinding): Promise<void>;
}

export interface RefresherDeps {
  readonly host: RefresherHost;
  readonly options: RefresherOptions;
  readonly state: TransformState;
  readonly store: DiscoveryStore;
  readonly packageVersion: string;
  readonly discover?: (
    target: DiscoveryTarget,
    signal: AbortSignal,
  ) => Promise<DiscoveryResult>;
  readonly now?: () => number;
  readonly debounceMs?: number;
}

export interface Refresher {
  start(): void;
  dispose(): void;
  /** Schedule a debounced sync, once the host has finished activating plugins. */
  trigger(): void;
  /**
   * Run a sync now, without waiting for the host's activation; resolves when
   * it has started or joined every job it needs.
   */
  sync(): Promise<void>;
  refresh(providerID?: string): RefreshOutput;
  handleEvent(event: HostEvent): void;
  catalog(): CatalogPayload;
}

/**
 * An eligible target with its credential resolved for this instance.
 * `keys` are the store keys from {@link credentialKeys}, not the sync keys.
 */
interface TargetState extends EligibleTarget {
  readonly credential: CredentialFingerprint;
  /** The key used for discovery: the integration key or `settings.apiKey`. */
  readonly discoveryKey?: string;
  /** The confirmation count when the sync that resolved the target started. */
  readonly generation: number;
}

/** Record identity of a target whose credential is not resolved. */
const UNRESOLVED = "unresolved";

/** Catalog record state of one provider ID. */
interface RecordState {
  /** The provider as the latest sync that found it eligible saw it. */
  target: EligibleTarget;
  /** Eligible in the latest sync, so listed in the catalog. */
  present: boolean;
  /**
   * {@link credentialIdentity} of the current resolution, {@link UNRESOLVED},
   * or undefined before the first sync that saw the provider.
   */
  identity: string | undefined;
  credentialEpoch: number;
  resultEpoch: number | null;
}

/**
 * The identity whose change increments a record's `credentialEpoch`: the
 * endpoint key, which covers `settings.apiKey` and provider headers, plus
 * the resolved credential fingerprint. The probe selection is left out,
 * because a probe-only edit keeps serving the active binding.
 */
function credentialIdentity(target: TargetState): string {
  return `${target.keys.endpointKey}\n${target.credential}`;
}

/** Headers that replace the discovery key, by probe (lowercase names). */
const ACTUALYZE_KEY_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "x-actualyze-api-key",
]);
const KEY_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "x-api-key",
]);

/**
 * Provider headers carry a header that replaces the key for the target's
 * probe. Actualyze's `/openai/v1` mount ignores `x-api-key`, so for that
 * probe only `authorization` and `x-actualyze-api-key` count.
 */
function headersReplaceKey(
  target: EligibleTarget,
  resolvedProbe: string | undefined,
): boolean {
  if (!target.headers) return false;
  const actualyze =
    target.probe === ACTUALYZE_PROBE_ID || resolvedProbe === ACTUALYZE_PROBE_ID;
  const names = actualyze ? ACTUALYZE_KEY_HEADERS : KEY_HEADERS;
  return Object.keys(target.headers).some((name) =>
    names.has(name.toLowerCase()),
  );
}

function credentialSource(
  target: TargetState,
  resolvedProbe: string | undefined,
): CredentialSource {
  if (headersReplaceKey(target, resolvedProbe)) return "headers";
  if (target.credential === "settings") return "settings";
  if (target.credential === "none") return "none";
  return "connection";
}

/**
 * The RPC copy of a store failure. One whose `httpStatus` is missing for an
 * HTTP kind, or does not match its kind, is reported as `error`, so the
 * record still passes the evidence validator instead of being dropped from
 * the payload.
 */
function toFailure(failure: ProviderFailure): ProviderFailure {
  const { kind, at, httpStatus, retryAt } = failure;
  const copy: ProviderFailure = {
    kind,
    at,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(retryAt === undefined ? {} : { retryAt }),
  };
  return isProviderFailure(copy) ? copy : { kind: "error", at };
}

// ── Persistence ─────────────────────────────────────────────────────────

/** A binding as stored: hashes and the inventory only, never secrets. */
export interface PersistedBinding {
  readonly version: 1;
  readonly key: string;
  readonly endpointKey: string;
  readonly providerID: string;
  readonly credential: CredentialFingerprint;
  readonly inventory: ProviderInventory;
}

export function toPersisted(binding: Binding): PersistedBinding {
  return {
    version: 1,
    key: binding.key,
    endpointKey: binding.endpointKey,
    providerID: binding.providerID,
    credential: binding.credential,
    inventory: binding.inventory,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const HEX_KEY = /^[0-9a-f]{64}$/;
const PROBE_ATTEMPTS: ReadonlySet<string> = new Set<ProbeAttempt>([
  "pending",
  "not-requested",
  "unresolved",
  "complete",
  "empty",
  "aborted",
  "error",
]);

function readInventory(value: unknown): ProviderInventory | undefined {
  if (!isRecord(value) || !Array.isArray(value.models)) return undefined;
  const completedAt = value.completedAt;
  if (
    typeof completedAt !== "string" ||
    !Number.isFinite(Date.parse(completedAt)) ||
    new Date(Date.parse(completedAt)).toISOString() !== completedAt
  )
    return undefined;
  if (value.modelListAttempt !== "ready" && value.modelListAttempt !== "empty")
    return undefined;
  if (
    typeof value.probeAttempt !== "string" ||
    !PROBE_ATTEMPTS.has(value.probeAttempt)
  )
    return undefined;
  const resolvedProbe =
    typeof value.resolvedProbe === "string"
      ? toProbeKey(value.resolvedProbe)
      : undefined;
  const endpointOrigin = sanitizeEndpointOrigin(value.endpointOrigin);
  const models: InventoryModel[] = [];
  const seen = new Set<string>();
  for (const model of value.models) {
    if (!isRecord(model) || !isBoundedString(model.id) || seen.has(model.id))
      continue;
    seen.add(model.id);
    const created =
      typeof model.created === "number" &&
      Number.isFinite(model.created) &&
      model.created > 0
        ? model.created
        : undefined;
    const meta =
      model.meta === undefined ? undefined : sanitizeProbeMeta(model.meta);
    models.push({
      id: model.id,
      ...(created === undefined ? {} : { created }),
      ...(meta ? { meta } : {}),
    });
    if (models.length >= MAX_MODELS_PER_PROVIDER) break;
  }
  return {
    ...(endpointOrigin ? { endpointOrigin } : {}),
    ...(resolvedProbe ? { resolvedProbe } : {}),
    modelListAttempt: value.modelListAttempt,
    probeAttempt: value.probeAttempt as ProbeAttempt,
    models,
    completedAt,
  };
}

function isCredential(value: unknown): value is CredentialFingerprint {
  return (
    value === "none" ||
    value === "settings" ||
    (typeof value === "string" &&
      value.startsWith("integration:") &&
      HEX_KEY.test(value.slice("integration:".length)))
  );
}

/** Parse a stored binding; anything malformed is ignored. */
export function readPersisted(
  storageKey: string,
  value: unknown,
): Binding | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.key !== "string" ||
    !HEX_KEY.test(value.key) ||
    storageKey !== `${STORAGE_PREFIX}${value.key}` ||
    typeof value.endpointKey !== "string" ||
    !HEX_KEY.test(value.endpointKey) ||
    !isBoundedString(value.providerID) ||
    !isCredential(value.credential)
  )
    return undefined;
  const inventory = readInventory(value.inventory);
  if (!inventory) return undefined;
  return {
    key: value.key,
    endpointKey: value.endpointKey,
    providerID: value.providerID,
    credential: value.credential,
    inventory,
  };
}

export interface StorageLike {
  scan(options: { prefix: string; after?: string; limit?: number }): Promise<{
    entries: readonly { key: string; value: unknown }[];
    next?: string;
  }>;
  remove(key: string): Promise<void>;
}

/**
 * Seed the store from persisted bindings. Keeps the newest
 * {@link MAX_PERSISTED_BINDINGS} and removes the rest and any malformed
 * entry.
 */
export async function loadPersisted(
  storage: StorageLike,
  store: DiscoveryStore,
): Promise<void> {
  const found: Binding[] = [];
  const discard: string[] = [];
  let after: string | undefined;
  for (let page = 0; page < 16; page += 1) {
    const result = await storage.scan({
      prefix: STORAGE_PREFIX,
      ...(after === undefined ? {} : { after }),
      limit: 100,
    });
    for (const entry of result.entries) {
      const binding = readPersisted(entry.key, entry.value);
      if (binding) found.push(binding);
      else discard.push(entry.key);
    }
    if (result.next === undefined) break;
    after = result.next;
  }
  found.sort(
    (left, right) =>
      Date.parse(right.inventory.completedAt) -
      Date.parse(left.inventory.completedAt),
  );
  for (const binding of found.slice(MAX_PERSISTED_BINDINGS))
    discard.push(`${STORAGE_PREFIX}${binding.key}`);
  for (const binding of found.slice(0, MAX_PERSISTED_BINDINGS))
    store.seed(binding);
  await Promise.all(discard.map((key) => storage.remove(key).catch(() => {})));
}

// ── Refresher ───────────────────────────────────────────────────────────

function sameLocation(
  event: LocationLike | undefined,
  location: LocationLike,
): boolean {
  return (
    event === undefined ||
    (event.directory === location.directory &&
      event.workspaceID === location.workspaceID)
  );
}

function switchedIntegration(data: unknown): string | undefined {
  return isRecord(data) && typeof data.integrationID === "string"
    ? data.integrationID
    : undefined;
}

export function createRefresher(deps: RefresherDeps): Refresher {
  const { host, options, state, store } = deps;
  const now = deps.now ?? Date.now;
  const discover = deps.discover ?? discoverProvider;
  const debounceMs = deps.debounceMs ?? DEBOUNCE_MS;
  const lifetime = new AbortController();

  let targets = new Map<string, TargetState>();
  let disposed = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let intervalTimer: ReturnType<typeof setInterval> | undefined;
  let syncing: Promise<void> | undefined;
  let syncAgain = false;
  let reloading: Promise<void> | undefined;
  let reloadAgain = false;
  let startedAt: string | undefined;
  /** End of the latest discovery cycle this instance observed. */
  let cycleCompletedAt: string | undefined;
  /** When a sync first resolved this location's targets. */
  let resolvedAt: string | undefined;
  /** Number of `credential.switched` events this instance has handled. */
  let switches = 0;
  /**
   * The switch count of the latest switch per integration ID; the
   * `undefined` key records switches that named no integration.
   */
  const switchedAt = new Map<string | undefined, number>();

  /**
   * Record state per provider ID. Entries are never removed, so a provider
   * that leaves and returns keeps counting its `credentialEpoch` upward.
   */
  const records = new Map<string, RecordState>();
  const instanceID = randomUUID();
  let statusQueued = false;

  /**
   * Whether the host has finished the plugin activation that started this
   * instance; triggers before then only wait.
   */
  let activated = false;
  /**
   * Whether elapsed time alone activated this instance (the replacement
   * branch of `watchActivation`), so the provider list it reads may still be
   * half built. While held, the instance serves exactly the stored binding of
   * each target's current store key and starts no discovery job. Only a
   * located `plugin.updated` ends it, and only through a sync that started
   * after it (see `releaseAt`); elapsed time never does.
   */
  let held = false;
  /**
   * Located `plugin.updated` events that arrived while held. A sync notes the
   * count when it starts, before it reads the provider list, so a sync whose
   * count is below the latest one read that list before OpenCode reported
   * that loading finished.
   */
  let confirmations = 0;
  /**
   * While held, the count a sync must have started at to end the hold: the
   * latest confirmation's. Undefined until one arrives.
   */
  let releaseAt: number | undefined;
  /**
   * The count of the sync that ended the hold. A target resolved by a sync
   * that started before it never starts a job.
   */
  let liftedAt = 0;

  const lastSwitch = (integrationID: string): number =>
    Math.max(
      switchedAt.get(integrationID) ?? 0,
      switchedAt.get(undefined) ?? 0,
    );

  const iso = (at: number = now()): string => new Date(at).toISOString();

  /** Publish one `status` event for every change made in this turn. */
  const queueStatus = (): void => {
    if (disposed || statusQueued) return;
    statusQueued = true;
    queueMicrotask(() => {
      statusQueued = false;
      if (disposed) return;
      void Promise.resolve()
        .then(() => host.emitStatus(iso()))
        .catch(() => {});
    });
  };

  /**
   * Set a record's credential identity. Any change after the first
   * increments `credentialEpoch`; `resultEpoch` keeps its value, so the
   * record is not current until its new store key holds a result.
   */
  const setIdentity = (record: RecordState, identity: string): void => {
    if (record.identity === identity) return;
    const first = record.identity === undefined;
    record.identity = identity;
    if (first) return;
    record.credentialEpoch += 1;
    queueStatus();
  };

  /**
   * Mark the record's result as belonging to the current epoch when the
   * target's current store key has no running job and holds a binding or a
   * failure, whichever job or stored binding produced it. A store key
   * encodes one credential, so that result belongs to the current epoch.
   */
  const settleResult = (record: RecordState): void => {
    if (record.identity === undefined || record.identity === UNRESOLVED) return;
    const target = targets.get(record.target.providerID);
    if (!target) return;
    const entry = store.state(target.keys.key);
    if (entry && !entry.running && (entry.binding || entry.failure))
      record.resultEpoch = record.credentialEpoch;
  };

  const running = (): boolean =>
    [...targets.values()].some(
      (target) => store.state(target.keys.key)?.running === true,
    );

  const latest = (
    left: string | undefined,
    right: string | undefined,
  ): string | undefined =>
    left === undefined
      ? right
      : right === undefined || left >= right
        ? left
        : right;

  /** Newest inventory time among the bindings the current targets serve. */
  const newestServed = (): string | undefined => {
    let newest: string | undefined;
    for (const target of targets.values())
      newest = latest(
        newest,
        servedBinding(target, state)?.inventory.completedAt,
      );
    return newest;
  };

  /**
   * The targets and the binding each serves; a change means the catalog
   * payload changed even when no discovery job ran.
   */
  const servedSignature = (): string =>
    [...targets.values()]
      .map((target) => {
        const binding = servedBinding(target, state);
        return [
          target.providerID,
          target.keys.key,
          binding?.key ?? "",
          binding?.inventory.completedAt ?? "",
        ].join("\n");
      })
      .sort()
      .join("\n\n");

  type CatalogTimes =
    | { status: "pending" }
    | { status: "running"; startedAt: string; completedAt?: string }
    | { status: "complete"; startedAt?: string; completedAt: string };

  /**
   * Status and times under the evidence contract's rules: pending has no
   * completedAt, running needs startedAt, and complete needs a completedAt
   * not earlier than startedAt. Pending lasts only until a sync resolves the
   * targets; with no job running the catalog is complete as of its newest
   * served inventory or observed cycle, else as of that resolution.
   */
  const catalogTimes = (): CatalogTimes => {
    if (resolvedAt === undefined) return { status: "pending" };
    const newest = latest(cycleCompletedAt, newestServed());
    if (running())
      return {
        status: "running",
        startedAt: startedAt ?? iso(),
        ...(newest === undefined ? {} : { completedAt: newest }),
      };
    const completedAt = newest ?? resolvedAt;
    return {
      status: "complete",
      ...(startedAt !== undefined && startedAt <= completedAt
        ? { startedAt }
        : {}),
      completedAt,
    };
  };

  /** Publish `updated` whenever the catalog has a completed state to report. */
  const emitCatalog = (): void => {
    if (disposed) return;
    const times = catalogTimes();
    if (times.status !== "pending" && times.completedAt !== undefined)
      void host.emitUpdated(times.completedAt).catch(() => {});
  };

  const reload = (): Promise<void> => {
    if (reloading) {
      reloadAgain = true;
      return reloading;
    }
    const run = async (): Promise<void> => {
      do {
        reloadAgain = false;
        if (disposed) return;
        await host.reload().catch(() => {});
      } while (reloadAgain);
    };
    reloading = run().finally(() => {
      reloading = undefined;
    });
    return reloading;
  };

  const markCompleted = (): void => {
    if (running()) return;
    cycleCompletedAt = iso();
    if (startedAt !== undefined && cycleCompletedAt < startedAt)
      cycleCompletedAt = startedAt;
  };

  /**
   * Announce a settled job: `updated` and `status` after the reload, when
   * the binding needs one, so the payload's model evidence comes from a
   * fold that has seen it.
   */
  const announce = (afterReload: boolean): void => {
    const done = afterReload ? reload() : Promise.resolve();
    void done.then(() => {
      if (disposed) return;
      markCompleted();
      emitCatalog();
      queueStatus();
    });
  };

  const subscriber: Subscriber = {
    onUpdate(key: string, update: StoreUpdate): void {
      if (disposed) return;
      // A key no target of this instance resolves to any more, such as one
      // from before a credential switch, says nothing about what to serve.
      const affected = [...targets.values()].filter(
        (target) => target.keys.key === key,
      );
      if (affected.length === 0) return;
      // A job started on this key, here or in another location sharing it:
      // `discovering`, `lastAttemptAt`, and `nextRefreshAt` changed.
      if (update === "started") {
        queueStatus();
        return;
      }
      if (update === "invalidated") {
        for (const [providerID, binding] of state.active) {
          if (binding.key === key) state.active.delete(providerID);
        }
        void reload();
        trigger();
        queueStatus();
        return;
      }
      for (const target of affected) {
        const record = records.get(target.providerID);
        if (record) settleResult(record);
      }
      if (update === "binding") {
        const binding = store.served(key);
        if (binding)
          for (const target of affected)
            state.active.set(target.providerID, binding);
        announce(true);
        return;
      }
      announce(false);
    },
    persist: (binding) =>
      host.persist(`${STORAGE_PREFIX}${binding.key}`, toPersisted(binding)),
  };

  /**
   * Start or join the target's discovery job. Every path into discovery
   * (sync, the interval, credential events, RPC `refresh`) comes through
   * here, so a held instance sends no request, with a key or without one,
   * and neither does a target read before the confirmation that ended a
   * hold.
   */
  const startJob = (
    target: TargetState,
  ): ReturnType<DiscoveryStore["start"]> | "held" => {
    if (held || target.generation < liftedAt) return "held";
    const discoveryTarget: DiscoveryTarget = {
      providerID: target.providerID,
      baseURL: target.baseURL,
      ...(target.discoveryKey ? { apiKey: target.discoveryKey } : {}),
      ...(target.headers ? { headers: target.headers } : {}),
      ...(target.probe ? { probe: target.probe } : {}),
    };
    const wasRunning = running();
    const result = store.start(target.keys.key, {
      credential: target.credential,
      endpointKey: target.keys.endpointKey,
      providerID: target.providerID,
      timeoutMs: options.timeoutMs,
      run: (signal) => discover(discoveryTarget, signal),
    });
    if (result !== "throttled") {
      if (!wasRunning) startedAt = iso();
      queueStatus();
    }
    return result;
  };

  const withCredential = (
    target: EligibleTarget,
    generation: number,
    credential: CredentialFingerprint,
    discoveryKey: string | undefined,
  ): TargetState => ({
    ...target,
    keys: credentialKeys(target.keys, credential),
    credential,
    ...(discoveryKey === undefined ? {} : { discoveryKey }),
    generation,
  });

  /**
   * Resolve the credential a target discovers with, in the order the host
   * uses for inference: the integration's active connection, then
   * `settings.apiKey`, then no key.
   *
   * A failed lookup says nothing about the connection. It keeps the
   * previous integration or keyless resolution for the same integration;
   * otherwise it falls back to `settings.apiKey`, or leaves the target out
   * of this sync when there is none. Treating it as "no connection" would
   * drop a good binding and rediscover with another key or none. A
   * credential switch removes the previous resolution, so a lookup that
   * fails after a switch does not reuse the previous account.
   */
  const resolveTarget = async (
    target: EligibleTarget,
    generation: number,
  ): Promise<TargetState | undefined> => {
    let credential: ActiveCredential | undefined;
    try {
      credential = await host.activeCredential(target.integrationID);
    } catch {
      const previous = targets.get(target.providerID);
      const kept =
        previous?.integrationID === target.integrationID &&
        previous.credential !== "settings"
          ? previous
          : undefined;
      if (kept && (kept.credential !== "none" || !target.apiKey))
        return withCredential(
          target,
          generation,
          kept.credential,
          kept.discoveryKey,
        );
      if (target.apiKey)
        return withCredential(target, generation, "settings", target.apiKey);
      return undefined;
    }
    if (!credential)
      return target.apiKey
        ? withCredential(target, generation, "settings", target.apiKey)
        : withCredential(target, generation, "none", undefined);
    return withCredential(
      target,
      generation,
      `integration:${fingerprint(
        "integration",
        `${credential.connection}\n${credential.key}`,
      )}`,
      credential.key,
    );
  };

  const runSync = async (): Promise<void> => {
    const epoch = switches;
    // Noted before the provider list is read, so a confirmation that arrives
    // while this sync waits does not count for what it read.
    const generation = confirmations;
    let providers: readonly ProviderLike[];
    try {
      providers = await host.listProviders();
    } catch {
      return;
    }
    if (disposed) return;
    const eligible: EligibleTarget[] = [];
    for (const provider of providers) {
      try {
        const target = eligibleTarget(provider, state.recorded);
        if (target) eligible.push(target);
      } catch {
        // A malformed provider is skipped.
      }
    }
    // A switch during this sync may have come after a lookup returned the
    // previous account, or no connection, so every resolution it covers is
    // dropped; the switch scheduled another sync to resolve them again.
    const resolved = (
      await Promise.all(
        eligible.map((target) => resolveTarget(target, generation)),
      )
    ).filter(
      (target): target is TargetState =>
        target !== undefined && lastSwitch(target.integrationID) <= epoch,
    );
    if (disposed) return;

    const firstResolution = resolvedAt === undefined;
    const before = servedSignature();
    const next = new Map(resolved.map((target) => [target.providerID, target]));
    for (const previous of targets.values()) {
      const current = next.get(previous.providerID);
      if (!current || current.keys.key !== previous.keys.key)
        store.unsubscribe(previous.keys.key, subscriber);
      if (!current) state.active.delete(previous.providerID);
    }
    for (const target of next.values())
      store.subscribe(target.keys.key, subscriber);
    targets = next;

    // Every eligible provider keeps a record; one left out of `next` has no
    // resolution this sync and is `unresolved`.
    const eligibleIDs = new Set<string>();
    for (const target of eligible) {
      eligibleIDs.add(target.providerID);
      let record = records.get(target.providerID);
      if (!record) {
        record = {
          target,
          present: true,
          identity: undefined,
          credentialEpoch: 0,
          resultEpoch: null,
        };
        records.set(target.providerID, record);
      }
      record.target = target;
      record.present = true;
      const current = next.get(target.providerID);
      setIdentity(record, current ? credentialIdentity(current) : UNRESOLVED);
    }
    for (const record of records.values())
      if (!eligibleIDs.has(record.target.providerID)) record.present = false;

    // A confirmation ends the hold only here, once a sync that started after
    // it has replaced the targets, so neither RPC `refresh` nor a sync that
    // read the list earlier can start a job for what it read.
    if (held && releaseAt !== undefined && generation >= releaseAt) {
      held = false;
      releaseAt = undefined;
      liftedAt = generation;
      queueStatus();
    }

    let changed = false;
    for (const target of next.values()) {
      const key = target.keys.key;
      const active = state.active.get(target.providerID);
      if (active && active.credential !== target.credential) {
        state.active.delete(target.providerID);
        changed = true;
      }
      if (store.verify(key, target.credential)) changed = true;
      // The key already encodes the credential; the comparison only guards
      // against a stored entry whose recorded credential disagrees with it.
      const stored = store.served(key);
      const current =
        stored?.credential === target.credential ? stored : undefined;
      if (held) {
        // Nothing replaces a binding while held, so the target serves the
        // binding of its current store key or nothing: not one kept from an
        // earlier probe selection, and not one from another endpoint.
        if (state.active.get(target.providerID) !== current) {
          if (current) state.active.set(target.providerID, current);
          else state.active.delete(target.providerID);
          changed = true;
        }
      } else if (current && state.active.get(target.providerID) !== current) {
        state.active.set(target.providerID, current);
        changed = true;
      }
      // An inventory finished within one discovery timeout of the interval
      // counts as due, so the periodic tick does not skip every other turn.
      const stale =
        !current ||
        (options.refreshIntervalMs > 0 &&
          now() -
            Date.parse(current.inventory.completedAt) +
            options.timeoutMs >=
            options.refreshIntervalMs);
      if (stale) startJob(target);
    }
    for (const record of records.values())
      if (record.present) settleResult(record);
    resolvedAt ??= iso();
    if (changed) void reload();
    // Announced after any reload in flight, so the payload's model evidence
    // comes from a fold that has seen the served bindings.
    if (firstResolution || servedSignature() !== before)
      void (reloading ?? Promise.resolve()).then(emitCatalog);
  };

  const sync = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (syncing) {
      syncAgain = true;
      return syncing;
    }
    const run = async (): Promise<void> => {
      do {
        syncAgain = false;
        await runSync().catch(() => {});
      } while (syncAgain && !disposed);
    };
    syncing = run().finally(() => {
      syncing = undefined;
    });
    return syncing;
  };

  const trigger = (): void => {
    if (disposed || !activated) return;
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void sync();
    }, debounceMs);
  };

  /**
   * Let triggers through from now on, and run a sync. `confirmed` is false
   * when elapsed time is the only evidence that the host's activation has
   * ended; the instance is then held. A confirmation while held does not
   * lift the hold itself: the next sync that starts after it does, once it
   * has replaced the targets.
   */
  const activate = (confirmed: boolean): void => {
    if (disposed) return;
    if (activated) {
      if (!confirmed || !held) return;
      confirmations += 1;
      releaseAt = confirmations;
      trigger();
      return;
    }
    activated = true;
    held = !confirmed;
    trigger();
  };

  const handleEvent = (event: HostEvent): void => {
    if (disposed || !TRIGGER_EVENTS.has(event.type)) return;
    if (!sameLocation(event.location, host.location)) return;
    // The host publishes `plugin.updated` only after an activation has set
    // up every plugin and published its batched state changes, and only
    // under the lock that activation holds, so it never comes from the
    // middle of one. It names the location whose activation it reports; one
    // without a location could come from another location's.
    if (event.type === "plugin.updated" && event.location !== undefined)
      activate(true);
    if (event.type === "credential.switched") {
      // Each affected target's resolution belongs to the previous account,
      // or, for a `settings.apiKey` or keyless resolution, to a time when
      // the integration had no connection; a newly connected key takes
      // precedence over both. Revoking it and leaving its store key means
      // the target serves nothing until a sync resolves the current
      // connection, and a failed lookup has no integration resolution to
      // fall back to. The target's record stays, `unresolved` and with a
      // new epoch, until that sync. Store entries stay: each is keyed by
      // the credential that produced it, other locations may still use
      // that credential, and a job is aborted only when its last
      // subscriber leaves.
      // `credential.updated` carries no integration and only triggers a
      // sync; the host also publishes `credential.switched` whenever an
      // integration's active credential changes, including the first one.
      const integrationID = switchedIntegration(event.data);
      switches += 1;
      switchedAt.set(integrationID, switches);
      let dropped = false;
      for (const target of [...targets.values()]) {
        if (
          integrationID !== undefined &&
          target.integrationID !== integrationID
        )
          continue;
        targets.delete(target.providerID);
        store.unsubscribe(target.keys.key, subscriber);
        dropped = state.active.delete(target.providerID) || dropped;
        const record = records.get(target.providerID);
        if (record) setIdentity(record, UNRESOLVED);
      }
      // The reload drops the old account's models now. The catalog event
      // waits for the follow-up sync, so the TUI never sees the revoked
      // providers as missing from discovery.
      if (dropped) void reload();
    }
    trigger();
  };

  /** Wait `ms`, or less when the refresher is disposed. */
  const pause = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (lifetime.signal.aborted) {
        resolve();
        return;
      }
      const abort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        lifetime.signal.removeEventListener("abort", abort);
        resolve();
      }, ms);
      lifetime.signal.addEventListener("abort", abort, { once: true });
    });

  const listen = async (): Promise<void> => {
    let delay = EVENT_RETRY_MS;
    while (!disposed) {
      try {
        for await (const event of host.events(lifetime.signal)) {
          delay = EVENT_RETRY_MS;
          handleEvent(event);
          if (disposed) return;
        }
      } catch {
        // The stream failed; resubscribe after a delay.
      }
      if (disposed) return;
      await pause(delay);
      delay = Math.min(EVENT_RETRY_MAX_MS, delay * 2);
    }
  };

  /**
   * The fallback for a `plugin.updated` this instance never sees, because
   * its subscription started late or failed, or because the host published
   * none: a reload that leaves the plugin list unchanged publishes none.
   *
   * The host replaces its plugin list only at the end of an activation, and
   * keeps an entry for this plugin through a reload of it. So when the first
   * read that answers has no entry, this is the plugin's first activation at
   * this location, and the first later read that has one comes after it.
   * That case activates fully. When the first read that answers already has
   * one, the entry may be the instance's own after a first activation whose
   * earlier reads failed, or the one this instance replaces, which stays
   * until the reload ends. Nothing tells the two apart, so once
   * {@link REPLACEMENT_WAIT_MS} have passed since start the instance
   * activates held: it serves stored bindings and sends no request.
   */
  const watchActivation = async (): Promise<void> => {
    const since = now();
    /** Set by the first read that answers. */
    let replacing: boolean | undefined;
    let delay = 0;
    while (!activated && !disposed) {
      if (delay > 0) {
        await pause(delay);
        if (activated || disposed) return;
      }
      delay =
        delay === 0
          ? ACTIVATION_PROBE_MS
          : Math.min(ACTIVATION_PROBE_MAX_MS, delay * 2);
      let listed: boolean;
      try {
        listed = await host.pluginListed();
      } catch {
        continue;
      }
      if (activated || disposed) return;
      if (replacing === undefined) replacing = listed;
      else if (listed && !replacing) activate(true);
      else if (listed && now() - since >= REPLACEMENT_WAIT_MS) activate(false);
    }
  };

  const refresh = (providerID?: string): RefreshOutput => {
    if (disposed) return { accepted: false, reason: "no-targets" };
    const selected = [...targets.values()].filter(
      (target) => providerID === undefined || target.providerID === providerID,
    );
    if (selected.length === 0) return { accepted: false, reason: "no-targets" };
    let accepted = false;
    let refused = false;
    for (const target of selected) {
      const result = startJob(target);
      if (result === "held") refused = true;
      else if (result !== "throttled") accepted = true;
    }
    if (accepted) return { accepted };
    return { accepted, reason: refused ? "held" : "throttled" };
  };

  /**
   * A record that carries status fields only: no result, no models. Used
   * for an `unresolved` target and for a target whose credential changed
   * and whose new store key has no result yet, so nothing from the
   * previous credential appears under the new one.
   */
  const statusRecord = (
    target: EligibleTarget,
    record: RecordState,
    status: Pick<
      CatalogProviderRecord,
      "discovering" | "lastAttemptAt" | "nextRefreshAt" | "credentialSource"
    >,
  ): CatalogProviderRecord => {
    const origin = sanitizeEndpointOrigin(normalizeBaseURL(target.baseURL));
    return {
      id: target.providerID,
      endpointOrigin: origin
        ? knownScalar(origin, "pre-existing", "configured")
        : unknownScalar(),
      configuredProbe:
        target.probe && isBoundedString(target.probe)
          ? knownScalar(target.probe, "pre-existing", "configured")
          : unknownScalar(),
      resolvedProbe: unknownScalar(),
      lastGoodAt: null,
      failure: null,
      modelListAttempt: "pending",
      probeAttempt: target.probe ? "pending" : "not-requested",
      skippedModelIds: [],
      models: [],
      ...status,
      held,
      credentialEpoch: record.credentialEpoch,
      resultEpoch: record.resultEpoch,
    };
  };

  const providerRecord = (record: RecordState): CatalogProviderRecord => {
    settleResult(record);
    const target =
      record.identity === UNRESOLVED
        ? undefined
        : targets.get(record.target.providerID);
    if (!target)
      return statusRecord(record.target, record, {
        discovering: false,
        lastAttemptAt: null,
        nextRefreshAt: null,
        credentialSource: "unresolved",
      });
    const entry = store.state(target.keys.key);
    const binding = servedBinding(target, state);
    const lastStartedAt = entry?.lastStartedAt;
    const nextAt = Math.max(
      lastStartedAt === undefined
        ? Number.NEGATIVE_INFINITY
        : lastStartedAt + MIN_REFRESH_INTERVAL_MS,
      entry?.retryAt ?? Number.NEGATIVE_INFINITY,
    );
    const status = {
      discovering: entry?.running === true,
      lastAttemptAt: lastStartedAt === undefined ? null : iso(lastStartedAt),
      nextRefreshAt:
        Number.isFinite(nextAt) && nextAt > now() ? iso(nextAt) : null,
      credentialSource: credentialSource(
        target,
        binding?.inventory.resolvedProbe,
      ),
    };
    if (
      record.credentialEpoch > 0 &&
      record.resultEpoch !== record.credentialEpoch
    )
      return statusRecord(target, record, status);
    const view = state.view.get(target.providerID);
    const inventory = binding?.inventory;
    const declared = view?.declared ?? new Set<string>();
    const mapped =
      view?.inventory !== undefined && view.inventory === inventory
        ? view.mapped
        : [];
    const served = new Set(inventory?.models.map((model) => model.id) ?? []);
    const models: CatalogModelRecord[] = [];
    for (const id of declared) {
      if (models.length >= MAX_MODELS_PER_PROVIDER) break;
      if (isBoundedString(id)) models.push(preExistingRecord(id));
    }
    for (const model of mapped) {
      if (models.length >= MAX_MODELS_PER_PROVIDER) break;
      if (!declared.has(model.id) && isBoundedString(model.id))
        models.push(model.evidence);
    }
    const origin = sanitizeEndpointOrigin(normalizeBaseURL(target.baseURL));
    // A mapping failure counts only for the inventory the fold mapped.
    const failure: ProviderFailure | null = entry?.failure
      ? toFailure(entry.failure)
      : view?.failed && inventory !== undefined && view.inventory === inventory
        ? { kind: "error", at: inventory.completedAt }
        : null;
    return {
      id: target.providerID,
      endpointOrigin: origin
        ? knownScalar(origin, "pre-existing", "configured")
        : unknownScalar(),
      configuredProbe:
        target.probe && isBoundedString(target.probe)
          ? knownScalar(target.probe, "pre-existing", "configured")
          : unknownScalar(),
      resolvedProbe: inventory?.resolvedProbe
        ? knownScalar(inventory.resolvedProbe, "provider-probe", "reported")
        : unknownScalar(),
      lastGoodAt: inventory?.completedAt ?? null,
      failure,
      modelListAttempt:
        inventory?.modelListAttempt ??
        entry?.failure?.modelListAttempt ??
        "pending",
      probeAttempt:
        inventory?.probeAttempt ?? (target.probe ? "pending" : "not-requested"),
      skippedModelIds: [...declared].filter(
        (id) => served.has(id) && isBoundedString(id),
      ),
      models,
      ...status,
      held,
      credentialEpoch: record.credentialEpoch,
      resultEpoch: record.resultEpoch,
    };
  };

  /**
   * `foreign` when an `actualyze` provider existed before scout's provider
   * transform and is not a discovery target. A failed addition, or no fold
   * yet, gives no evidence that another source defines the provider, so it
   * reports `managed` rather than telling the user to configure someone
   * else's provider.
   */
  const builtInActualyze = (): BuiltInState => {
    switch (state.actualyze) {
      case "existing":
        return records.get(ACTUALYZE_PROVIDER_ID)?.present === true
          ? "managed"
          : "foreign";
      case "added":
      case "failed":
      case undefined:
        return "managed";
    }
  };

  const catalog = (): CatalogPayload => {
    const base = {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      packageVersion: deps.packageVersion,
      instanceID,
      generatedAt: iso(),
      ...catalogTimes(),
      builtIn: { actualyze: builtInActualyze() },
    };
    const providers: CatalogProviderRecord[] = [];
    for (const recordState of records.values()) {
      if (!recordState.present) continue;
      let record: CatalogProviderRecord;
      try {
        record = providerRecord(recordState);
      } catch {
        continue;
      }
      // Drop a provider whose record fails validation rather than the payload.
      if (validateCatalogPayload({ ...base, providers: [record] }))
        providers.push(record);
    }
    const payload: CatalogPayload = { ...base, providers };
    return validateCatalogPayload(payload) ?? { ...base, providers: [] };
  };

  return {
    start(): void {
      void listen();
      void watchActivation();
      if (options.refreshIntervalMs > 0) {
        intervalTimer = setInterval(trigger, options.refreshIntervalMs);
        (intervalTimer as { unref?: () => void }).unref?.();
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      if (intervalTimer !== undefined) clearInterval(intervalTimer);
      for (const target of targets.values())
        store.unsubscribe(target.keys.key, subscriber);
      targets = new Map();
    },
    trigger,
    sync,
    refresh,
    handleEvent,
    catalog,
  };
}
