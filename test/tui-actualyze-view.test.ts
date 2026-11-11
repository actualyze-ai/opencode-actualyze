import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The reconciler needs a live renderer; the mock records the
// createElement/setProp/insert calls the plugin makes, and the core mock
// stands in for StyledText.
const { reconcilerMock, coreMock } = vi.hoisted(() => ({
  reconcilerMock: () => ({
    createElement: (tag: string) => ({
      tag,
      props: {} as Record<string, unknown>,
      children: [] as unknown[],
      content: undefined as unknown,
    }),
    setProp: (
      node: { props: Record<string, unknown> },
      name: string,
      value: unknown,
    ) => {
      node.props[name] = value;
      return value;
    },
    insert: (node: { children: unknown[] }, child: unknown) => {
      node.children.push(child);
      return child;
    },
  }),
  coreMock: () => ({
    StyledText: class {
      constructor(readonly chunks: Array<{ text: string; fg?: unknown }>) {}
    },
    parseColor: (color: unknown) => color,
    TextAttributes: { BOLD: 1 },
  }),
}));
vi.mock("@opentui/solid", reconcilerMock);
vi.mock("@opentui/core", coreMock);

import type { Plugin } from "@opencode/plugin/tui";
import {
  CATALOG_SCHEMA_VERSION,
  knownScalar,
  unknownCapability,
  unknownScalar,
  type CatalogModelRecord,
  type CatalogPayload,
  type CatalogProviderRecord,
} from "../src/catalog-evidence";
import { PROBE_KEYS } from "../src/constants";
import { closeActualyze, openActualyze } from "../src/tui-actualyze-view";
import type { HostModel, HostProvider } from "../src/tui-models";

interface MockNode {
  props?: Record<string, unknown>;
  children?: MockNode[];
  content?: unknown;
}

const PROJECT = { directory: "/work/project" };
const AT = "2026-10-17T08:00:00.000Z";
/** Content rows of the dialog at 120x36: `min(30, rows - 4)`. */
const FULL_HEIGHT = 30;

function findNodeById(node: unknown, id: string): MockNode | undefined {
  if (!node || typeof node !== "object") return undefined;
  const candidate = node as MockNode;
  if (candidate.props?.id === id) return candidate;
  for (const child of candidate.children ?? []) {
    const found = findNodeById(child, id);
    if (found) return found;
  }
  return undefined;
}

function textOf(node: MockNode | undefined): string {
  const content = node?.content;
  if (content && typeof content === "object" && "chunks" in content)
    return (content as { chunks: Array<{ text: string }> }).chunks
      .map((chunk) => chunk.text)
      .join("");
  return "";
}

function visible(node: MockNode | undefined): boolean {
  return node?.props?.visible !== false;
}

function pane(root: unknown): string {
  const box = findNodeById(root, "modelscout-pane");
  if (!visible(box)) return "";
  return (box?.children ?? [])
    .filter(visible)
    .map((child) => textOf(child).trimEnd())
    .join("\n");
}

function line(root: unknown, id: string): string {
  return textOf(findNodeById(root, id)).trimEnd();
}

/** Let queued microtasks and pending continuations run. */
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

/**
 * Settle, then let one real macrotask pass, so a dialog whose modules are
 * still loading has opened before a test says none did.
 */
async function drain(): Promise<void> {
  await settle();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await settle();
}

function rootHeight(root: unknown): unknown {
  return findNodeById(root, "modelscout-browser")?.props?.height;
}

function color(name: string) {
  return { name };
}

function stateful(prefix: string) {
  return {
    focused: color(`${prefix}.focused`),
    disabled: color(`${prefix}.disabled`),
    selected: color(`${prefix}.selected`),
  };
}

function surface() {
  return {
    text: {
      base: color("text.base"),
      muted: color("text.muted"),
      action: { primary: stateful("text.action.primary") },
      formfield: stateful("text.formfield"),
      feedback: {
        success: { base: color("success") },
        warning: { base: color("warning") },
        error: { base: color("error") },
        info: { base: color("info") },
      },
    },
    background: {
      action: { primary: stateful("background.action.primary") },
      formfield: stateful("background.formfield"),
    },
    border: { base: color("border.base") },
  };
}

const actualyzeProvider: HostProvider = {
  id: "actualyze",
  name: "Actualyze",
  package: "@opencode/ai/providers/openai-compatible",
  settings: { baseURL: "https://app.actualyze.ai/openai/v1" },
};

const hostModel: HostModel = {
  id: "claude-haiku",
  providerID: "actualyze",
  name: "Claude Haiku",
  enabled: true,
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  variants: [],
  cost: [],
  limit: { context: 200_000, output: 64_000 },
};

const modelRecord: CatalogModelRecord = {
  id: "claude-haiku",
  origin: "discovered",
  enabled: true,
  identity: knownScalar("claude-haiku", "server-list", "reported"),
  name: unknownScalar(),
  modelType: unknownScalar(),
  context: knownScalar(200_000, "provider-probe", "authoritative"),
  output: knownScalar(64_000, "provider-probe", "authoritative"),
  family: unknownScalar(),
  organizationOwner: unknownScalar(),
  parameterSize: unknownScalar(),
  quantization: unknownScalar(),
  sizeBytes: unknownScalar(),
  probeIdentity: unknownScalar(),
  capabilities: {
    toolCall: unknownCapability(),
    reasoning: unknownCapability(),
    temperature: unknownCapability(),
  },
  inputModalities: {
    text: unknownCapability(),
    image: unknownCapability(),
    pdf: unknownCapability(),
    audio: unknownCapability(),
    video: unknownCapability(),
  },
  cost: {
    input: unknownScalar(),
    output: unknownScalar(),
    cacheRead: unknownScalar(),
    cacheWrite: unknownScalar(),
  },
};

function record(
  overrides: Partial<CatalogProviderRecord> = {},
): CatalogProviderRecord {
  return {
    id: "actualyze",
    endpointOrigin: knownScalar(
      "https://app.actualyze.ai",
      "pre-existing",
      "configured",
    ),
    configuredProbe: knownScalar("actualyze", "pre-existing", "configured"),
    resolvedProbe: knownScalar("actualyze", "provider-probe", "reported"),
    lastGoodAt: AT,
    failure: null,
    modelListAttempt: "ready",
    probeAttempt: "complete",
    skippedModelIds: [],
    models: [modelRecord],
    discovering: false,
    lastAttemptAt: AT,
    nextRefreshAt: null,
    held: false,
    credentialSource: "connection",
    credentialEpoch: 1,
    resultEpoch: 1,
    ...overrides,
  };
}

function payload(
  provider:
    | CatalogProviderRecord
    | readonly CatalogProviderRecord[]
    | undefined,
  builtIn: "managed" | "foreign" = "managed",
): CatalogPayload {
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    packageVersion: "2.0.0",
    instanceID: "instance",
    generatedAt: AT,
    status: "complete",
    completedAt: AT,
    builtIn: { actualyze: builtIn },
    providers:
      provider === undefined
        ? []
        : "id" in provider
          ? [provider]
          : [...provider],
  };
}

interface Entry {
  render: () => unknown;
  onClose?: () => void;
  prompt?: true;
}

/** The fields of OpenCode's `IntegrationInfo` the harness lists. */
interface IntegrationRow {
  readonly id: string;
  readonly name: string;
  readonly methods: readonly {
    readonly type: string;
    readonly label?: string;
    readonly names?: readonly string[];
  }[];
  readonly connections: readonly Readonly<Record<string, unknown>>[];
}

interface State {
  connected: boolean;
  catalog: CatalogPayload;
  hostProviders: HostProvider[];
  hostModels: HostModel[];
  /** OpenCode's integrations; by default the plugin's own, connected as `connected` says. */
  integrations?: readonly IntegrationRow[];
}

const NO_KEY: State = {
  connected: false,
  catalog: payload(undefined),
  hostProviders: [],
  hostModels: [],
};

const READY: State = {
  connected: true,
  catalog: payload(record()),
  hostProviders: [actualyzeProvider],
  hostModels: [hostModel],
};

function harness(initial: State = NO_KEY) {
  let state = initial;
  let open: Entry | undefined;
  let root: unknown;
  let resolvePrompt: ((value: string | undefined) => void) | undefined;
  /** The host closes whatever it replaces before showing the next dialog. */
  const replace = (entry: Entry | undefined): void => {
    const previous = open;
    open = undefined;
    previous?.onClose?.();
    open = entry;
  };
  const dialog = {
    show: vi.fn((render: () => unknown, onClose?: () => void) => {
      replace({ render, ...(onClose ? { onClose } : {}) });
      root = render();
    }),
    set: vi.fn(),
    clear: vi.fn(() => replace(undefined)),
    prompt: vi.fn(
      () =>
        new Promise<string | undefined>((resolve) => {
          resolvePrompt = resolve;
          replace({
            render: () => null,
            onClose: () => resolve(undefined),
            prompt: true,
          });
        }),
    ),
  };
  const toast = { show: vi.fn() };
  const keyListeners = new Set<(key: unknown) => void>();
  const keyInput = {
    on: vi.fn((event: string, listener: (key: unknown) => void) => {
      if (event === "keypress") keyListeners.add(listener);
      return keyInput;
    }),
    off: vi.fn((event: string, listener: (key: unknown) => void) => {
      if (event === "keypress") keyListeners.delete(listener);
      return keyInput;
    }),
  };
  const rpcHandlers = new Map<string, Set<(event: unknown) => void>>();
  const connectKey = vi.fn(
    async (_input: unknown, _options: unknown): Promise<void> => undefined,
  );
  const dispatch = vi.fn();
  /** Unsubscribes of the session's fact events; four per session. */
  const stopFacts = vi.fn();
  /** Handlers of the fact events, by event type. */
  const factHandlers = new Map<string, Array<(event: unknown) => void>>();
  const catalog = vi.fn(async (): Promise<unknown> => state.catalog);
  const refresh = vi.fn(
    async (_input: unknown, _options: unknown): Promise<unknown> => ({
      accepted: true,
    }),
  );
  const integration = (): IntegrationRow => ({
    id: "actualyze",
    name: "Actualyze",
    methods: [{ type: "key" }, { type: "env", names: ["ACTUALYZE_API_KEY"] }],
    connections: state.connected
      ? [{ type: "credential", id: "c1", label: "Laptop", method: "key" }]
      : [],
  });
  const memories = new Map<
    string,
    readonly [object, (fn: (draft: object) => void) => void]
  >();
  const context = {
    location: PROJECT as { directory: string },
    data: {
      // The browser's own `model.updated` subscription is not a fact event.
      on: vi.fn((type: string, handler: (event: unknown) => void) => {
        if (type === "model.updated") return () => {};
        factHandlers.set(type, [...(factHandlers.get(type) ?? []), handler]);
        return stopFacts;
      }),
      location: {
        default: () => PROJECT,
        integration: {
          sync: vi.fn(async () => {}),
          list: vi.fn(() => state.integrations ?? [integration()]),
          invalidate: vi.fn(),
        },
        provider: {
          sync: vi.fn(async () => {}),
          list: vi.fn(() => state.hostProviders),
          invalidate: vi.fn(),
        },
      },
    },
    client: {
      rpc: vi.fn(() => ({
        catalog,
        refresh,
        events: {
          on: vi.fn((name: string, handler: (event: unknown) => void) => {
            const set = rpcHandlers.get(name) ?? new Set();
            set.add(handler);
            rpcHandlers.set(name, set);
            return () => set.delete(handler);
          }),
        },
      })),
      model: {
        list: vi.fn(async (input: { location: unknown }) => ({
          location: input.location,
          data: state.hostModels,
        })),
      },
      provider: {
        list: vi.fn(async (input: { location: unknown }) => ({
          location: input.location,
          data: state.hostProviders,
        })),
      },
      integration: { connect: { key: connectKey } },
    },
    ui: { dialog, toast, model: { current: () => undefined } },
    keymap: { dispatch },
    storage: {
      memory: vi.fn((key: string, input: { initial: object }) => {
        const existing = memories.get(key);
        if (existing) return existing;
        const value = structuredClone(input.initial);
        const entry = [
          value,
          (fn: (draft: object) => void) => fn(value),
        ] as const;
        memories.set(key, entry);
        return entry;
      }),
    },
    renderer: {
      terminalWidth: 120,
      terminalHeight: 36,
      keyInput,
      on: vi.fn(),
      off: vi.fn(),
      copyToClipboardOSC52: vi.fn(() => true),
      isOsc52Supported: vi.fn(() => true),
    },
    theme: { surface },
    themeMode: "dark",
  };
  const plugin = context as unknown as Plugin.Context;
  const openModelScout = vi.fn();

  return {
    context,
    plugin,
    dialog,
    toast,
    connectKey,
    dispatch,
    stopFacts,
    catalog,
    refresh,
    copied: context.renderer.copyToClipboardOSC52,
    openModelScout,
    root: () => root,
    current: () => open,
    open: () => openActualyze(plugin, { openModelScout }),
    setState: (next: State) => {
      state = next;
    },
    emitRpc: (name: string) => {
      for (const handler of rpcHandlers.get(name) ?? [])
        handler({ location: PROJECT });
    },
    /** Publish an OpenCode event such as `provider.updated` at the project. */
    emitFact: (type: string) => {
      for (const handler of factHandlers.get(type) ?? [])
        handler({ location: PROJECT });
    },
    submitPrompt: (value: string | undefined) => resolvePrompt?.(value),
    press: (name: string) => {
      const event = {
        name,
        ctrl: false,
        meta: false,
        shift: false,
        option: false,
        super: false,
        hyper: false,
        sequence: name.length === 1 ? name : "",
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };
      for (const listener of [...keyListeners]) listener(event);
      return event;
    },
  };
}

type Harness = ReturnType<typeof harness>;

async function openedAt(h: Harness, text: string | RegExp): Promise<void> {
  await h.open();
  await vi.waitFor(() => expect(pane(h.root())).toMatch(text));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Press k, submit a key, and wait until the dialog shows again. */
async function submitKey(h: Harness): Promise<void> {
  h.press("k");
  expect(h.dialog.prompt).toHaveBeenCalledOnce();
  const shows = h.dialog.show.mock.calls.length;
  h.submitPrompt("aai_pat_test");
  await vi.waitFor(() =>
    expect(h.dialog.show.mock.calls.length).toBe(shows + 1),
  );
  expect(h.connectKey).toHaveBeenCalledOnce();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("plugin unload while the key prompt is open", () => {
  it("closes the prompt, saves nothing, and shows nothing again", async () => {
    const h = harness();
    await openedAt(h, /Connect an Actualyze API key/);
    h.press("k");
    expect(h.current()?.prompt).toBe(true);
    const shows = h.dialog.show.mock.calls.length;

    closeActualyze(h.plugin);
    await settle();
    expect(h.dialog.clear).toHaveBeenCalledOnce();
    expect(h.current()).toBeUndefined();
    expect(h.connectKey).not.toHaveBeenCalled();
    expect(h.dialog.show.mock.calls.length).toBe(shows);
    expect(h.toast.show).not.toHaveBeenCalled();
  });

  it("says a key submitted as the plugin unloaded was not saved", async () => {
    const h = harness();
    await openedAt(h, /Connect an Actualyze API key/);
    h.press("k");
    // The host has not closed the prompt yet when the answer arrives.
    h.dialog.clear.mockImplementationOnce(() => {});
    closeActualyze(h.plugin);
    h.submitPrompt("aai_pat_test");
    await vi.waitFor(() => expect(h.toast.show).toHaveBeenCalledOnce());
    expect(h.toast.show.mock.calls[0]?.[0]).toMatchObject({
      variant: "warning",
      message: expect.stringContaining("not saved"),
    });
    expect(JSON.stringify(h.toast.show.mock.calls)).not.toContain(
      "aai_pat_test",
    );
    expect(h.connectKey).not.toHaveBeenCalled();
  });

  it("leaves a dialog that replaced the prompt alone", async () => {
    const h = harness();
    await openedAt(h, /Connect an Actualyze API key/);
    h.press("k");
    h.dialog.show(() => "other");
    await Promise.resolve();
    h.dialog.clear.mockClear();
    closeActualyze(h.plugin);
    await settle();
    expect(h.dialog.clear).not.toHaveBeenCalled();
    expect(h.current()?.render()).toBe("other");
  });

  it("leaves a dialog that replaced the prompt in the same tick as the cleanup alone", async () => {
    const h = harness();
    await openedAt(h, /Connect an Actualyze API key/);
    h.press("k");
    h.dialog.clear.mockClear();
    // No await between: the prompt has settled, but its continuation has not run.
    h.dialog.show(() => "other");
    closeActualyze(h.plugin);
    await settle();
    expect(h.dialog.clear).not.toHaveBeenCalled();
    expect(h.current()?.render()).toBe("other");
    expect(h.toast.show).not.toHaveBeenCalled();
  });
});

describe("the key prompt's answer", () => {
  it("ends the session without showing the dialog again when the prompt is cancelled", async () => {
    const h = harness();
    await openedAt(h, /Connect an Actualyze API key/);
    h.press("k");
    const shows = h.dialog.show.mock.calls.length;
    h.submitPrompt(undefined);
    await settle();
    expect(h.dialog.show.mock.calls.length).toBe(shows);
    expect(h.stopFacts).toHaveBeenCalledTimes(4);
    expect(h.connectKey).not.toHaveBeenCalled();
  });

  it("ends the session when another dialog replaced the prompt, and leaves that dialog open", async () => {
    const h = harness();
    await openedAt(h, /Connect an Actualyze API key/);
    h.press("k");
    const shows = h.dialog.show.mock.calls.length;
    h.dialog.show(() => "other");
    await settle();
    expect(h.dialog.show.mock.calls.length).toBe(shows + 1);
    expect(h.current()?.render()).toBe("other");
    expect(h.stopFacts).toHaveBeenCalledTimes(4);
  });

  it("shows the dialog again unchanged after an empty answer", async () => {
    const h = harness();
    await openedAt(h, /Connect an Actualyze API key/);
    const before = pane(h.root());
    h.press("k");
    const shows = h.dialog.show.mock.calls.length;
    h.submitPrompt("   ");
    await vi.waitFor(() =>
      expect(h.dialog.show.mock.calls.length).toBe(shows + 1),
    );
    await vi.waitFor(() => expect(pane(h.root())).toBe(before));
    expect(h.connectKey).not.toHaveBeenCalled();
    expect(h.stopFacts).not.toHaveBeenCalled();
  });

  it("shows the save as unconfirmed when OpenCode does not answer within 15 s", async () => {
    const h = harness();
    h.connectKey.mockReturnValueOnce(new Promise<void>(() => {}));
    await openedAt(h, /Connect an Actualyze API key/);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await submitKey(h);
      await vi.waitFor(() =>
        expect(pane(h.root())).toMatch(/OpenCode is storing the key/),
      );
      await vi.advanceTimersByTimeAsync(14_000);
      expect(pane(h.root())).toMatch(/OpenCode is storing the key/);
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.waitFor(() =>
        expect(pane(h.root())).toMatch(
          /OpenCode did not confirm the key was saved/,
        ),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("y", () => {
  it("copies the card's link on a card and the model ID in the list", async () => {
    const h = harness();
    await openedAt(h, /Connect an Actualyze API key/);
    h.press("y");
    expect(h.copied).toHaveBeenLastCalledWith(
      "https://app.actualyze.ai/account/settings?tab=security",
    );

    h.setState(READY);
    h.emitRpc("updated");
    await vi.waitFor(() => expect(rootHeight(h.root())).toBe(FULL_HEIGHT));
    h.press("y");
    expect(h.copied).toHaveBeenLastCalledWith("actualyze/claude-haiku");
  });
});

describe("a hidden provider with ACTUALYZE_OPENAI_BASE_URL set", () => {
  it("shows that endpoint as custom and links to it", async () => {
    vi.stubEnv(
      "ACTUALYZE_OPENAI_BASE_URL",
      "https://staging.example/openai/v1",
    );
    try {
      const h = harness();
      await openedAt(h, /Connect an Actualyze API key/);
      await vi.waitFor(() =>
        expect(line(h.root(), "modelscout-header")).toMatch(
          /custom endpoint\s+staging\.example/,
        ),
      );
      h.press("y");
      expect(h.copied).toHaveBeenLastCalledWith(
        "https://staging.example/account/settings?tab=security",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("a base URL that is not http(s)", () => {
  it("offers no links and never falls back to production", async () => {
    const h = harness({
      ...NO_KEY,
      hostProviders: [
        { ...actualyzeProvider, settings: { baseURL: "ftp://gw.example/v1" } },
      ],
    });
    await openedAt(h, /Connect an Actualyze API key/);
    await vi.waitFor(() =>
      expect(line(h.root(), "modelscout-header")).toMatch(
        /settings\.baseURL is not a URL/,
      ),
    );
    expect(pane(h.root())).not.toMatch(/https?:\/\//);
    expect(line(h.root(), "modelscout-footer")).not.toMatch(/copy link/);
    h.press("y");
    h.press("l");
    await vi.waitFor(() => expect(pane(h.root())).toMatch(/No app links/));
    h.press("y");
    h.press("return");
    expect(h.copied).not.toHaveBeenCalled();
    expect(pane(h.root())).not.toMatch(/app\.actualyze\.ai/);
  });
});

describe("a save that completes after the location changed", () => {
  it("ends the session and closes its dialog after a confirmed save", async () => {
    const h = harness();
    const save = deferred<void>();
    h.connectKey.mockReturnValueOnce(save.promise);
    await openedAt(h, /Connect an Actualyze API key/);
    await submitKey(h);
    await vi.waitFor(() =>
      expect(pane(h.root())).toMatch(/OpenCode is storing the key/),
    );

    h.context.location = { directory: "/elsewhere" };
    h.dialog.clear.mockClear();
    save.resolve();
    await vi.waitFor(() => expect(h.dialog.clear).toHaveBeenCalledOnce());
    expect(h.current()).toBeUndefined();
    expect(h.toast.show).not.toHaveBeenCalled();
  });

  it("ends the session, closes its dialog, and warns after an unconfirmed save", async () => {
    const h = harness();
    const save = deferred<void>();
    h.connectKey.mockReturnValueOnce(save.promise);
    await openedAt(h, /Connect an Actualyze API key/);
    await submitKey(h);

    h.context.location = { directory: "/elsewhere" };
    h.dialog.clear.mockClear();
    save.reject(new Error("socket hang up"));
    await vi.waitFor(() => expect(h.toast.show).toHaveBeenCalledOnce());
    expect(h.dialog.clear).toHaveBeenCalledOnce();
    expect(h.current()).toBeUndefined();
    expect(h.toast.show.mock.calls[0]?.[0]).toMatchObject({
      variant: "warning",
      message: "OpenCode did not confirm the Actualyze key was saved",
    });
  });

  it("does not close a dialog that replaced its own", async () => {
    const h = harness();
    const save = deferred<void>();
    h.connectKey.mockReturnValueOnce(save.promise);
    await openedAt(h, /Connect an Actualyze API key/);
    await submitKey(h);
    h.dialog.show(() => "other");

    h.context.location = { directory: "/elsewhere" };
    h.dialog.clear.mockClear();
    save.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.dialog.clear).not.toHaveBeenCalled();
    expect(h.current()?.render()).toBe("other");
  });
});

describe("keys under a card", () => {
  it("leaves k and c alone on a card that does not offer them", async () => {
    const h = harness({
      ...READY,
      catalog: payload(undefined, "foreign"),
    });
    await openedAt(h, /Another plugin or a models\.dev catalog/);
    const k = h.press("k");
    expect(h.dialog.prompt).not.toHaveBeenCalled();
    expect(k.preventDefault).not.toHaveBeenCalled();
    // `c` is listed on this card.
    h.press("c");
    expect(h.dispatch).toHaveBeenCalledWith("provider.connect");
  });

  it("leaves k and c alone on the links screen", async () => {
    const h = harness();
    await openedAt(h, /Connect an Actualyze API key/);
    h.press("l");
    await vi.waitFor(() =>
      expect(pane(h.root())).toMatch(/Actualyze app links/),
    );
    h.press("k");
    h.press("c");
    expect(h.dialog.prompt).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
    h.press("b");
    expect(h.openModelScout).toHaveBeenCalledOnce();
  });

  it("runs k and c on the no-key card, which lists both", async () => {
    const h = harness();
    await openedAt(h, /Connect an Actualyze API key/);
    h.press("c");
    expect(h.dispatch).toHaveBeenCalledWith("provider.connect");
  });

  it("never selects or opens the row hidden under a card", async () => {
    // OpenCode lists a model, but the card for a foreign provider replaces the list.
    const h = harness({ ...READY, catalog: payload(undefined, "foreign") });
    await openedAt(h, /Another plugin or a models\.dev catalog/);
    for (const name of ["return", "i", "m"])
      expect(h.press(name).preventDefault).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(pane(h.root())).toMatch(/Another plugin or a models\.dev catalog/);
  });
});

describe("selecting a model", () => {
  it("hands the model to OpenCode's picker with its search filled in", async () => {
    const h = harness(READY);
    await h.open();
    await vi.waitFor(() => expect(rootHeight(h.root())).toBe(FULL_HEIGHT));
    const field = {
      id: "picker-search",
      traits: { status: "FILTER" },
      value: "",
    };
    h.dispatch.mockImplementation((command: string) => {
      if (command === "model.list")
        Object.assign(h.context.renderer, { currentFocusedRenderable: field });
    });
    const event = h.press("return");
    expect(event.preventDefault).toHaveBeenCalled();
    expect(h.dispatch).toHaveBeenCalledWith("model.list");
    // The integration is connected, so the provider's name leads the search.
    await vi.waitFor(() => expect(field.value).toBe("Actualyze Claude Haiku"));
  });
});

describe("status line", () => {
  const chunks = (root: unknown): Array<{ text: string; fg?: unknown }> => {
    const content = findNodeById(root, "modelscout-status")?.content;
    return content && typeof content === "object" && "chunks" in content
      ? (content as { chunks: Array<{ text: string; fg?: unknown }> }).chunks
      : [];
  };

  it("colors only the glyph and writes the headline in base", async () => {
    const h = harness({
      ...READY,
      catalog: payload(
        record({
          lastGoodAt: null,
          models: [],
          failure: { kind: "unauthorized", at: AT, httpStatus: 401 },
        }),
      ),
      hostModels: [],
    });
    await openedAt(h, /Actualyze did not accept this key/);
    const [glyph, headline] = chunks(h.root());
    expect(glyph).toMatchObject({ text: "▲", fg: { name: "error" } });
    expect(headline).toMatchObject({
      text: " Key rejected (401)",
      fg: { name: "text.base" },
    });
  });

  it("counts the chat models the list shows, not hidden embeddings", async () => {
    const embedding: HostModel = {
      ...hostModel,
      id: "embed",
      name: "Embed",
      capabilities: { tools: false, input: ["text"], output: ["embedding"] },
    };
    const h = harness({
      ...READY,
      catalog: payload(
        record({
          models: [
            modelRecord,
            {
              ...modelRecord,
              id: "embed",
              modelType: knownScalar("embedding", "provider-probe", "reported"),
            },
          ],
        }),
      ),
      hostModels: [hostModel, embedding],
    });
    await h.open();
    await vi.waitFor(() =>
      expect(line(h.root(), "modelscout-status")).toMatch(
        /^● Catalog accessible · key "Laptop" · 1 model · checked/,
      ),
    );
  });
});

describe("an unknown configured probe", () => {
  const UNKNOWN = knownScalar("no-such-probe", "pre-existing", "configured");
  const WARNING = `Unknown probe "no-such-probe"; use auto or one of: ${PROBE_KEYS.join(", ")}`;
  const EFFECT =
    "No probe runs, so the models get no limits, prices, or capabilities from the server.";
  const shownRows = (root: unknown, id: string): string[] =>
    (findNodeById(root, id)?.children ?? [])
      .filter(visible)
      .map((child) => textOf(child).trimEnd());
  /** Card rows as running text: the bar dropped and wrapped rows joined. */
  const cardText = (rows: readonly string[]): string =>
    rows
      .map((row) => row.replace(/^▌ ?/, ""))
      .join(" ")
      .replace(/\s+/g, " ");
  const unknownState = (
    overrides: Partial<CatalogProviderRecord>,
    hostModels: HostModel[] = [hostModel],
  ): State => ({
    ...READY,
    catalog: payload(record({ configuredProbe: UNKNOWN, ...overrides })),
    hostModels,
  });
  const statusChunks = (
    root: unknown,
  ): Array<{ text: string; fg?: unknown }> => {
    const content = findNodeById(root, "modelscout-status")?.content;
    return content && typeof content === "object" && "chunks" in content
      ? (content as { chunks: Array<{ text: string; fg?: unknown }> }).chunks
      : [];
  };

  // A card that replaces the list shows in the pane; one above it, in the banner.
  const cases: Array<
    [string, Partial<CatalogProviderRecord>, "pane" | "banner", RegExp]
  > = [
    [
      "discovering",
      { discovering: true, lastGoodAt: null, models: [] },
      "pane",
      /Reading the catalog/,
    ],
    [
      "failure",
      {
        lastGoodAt: null,
        models: [],
        failure: { kind: "unauthorized", at: AT, httpStatus: 401 },
      },
      "pane",
      /Actualyze did not accept this key/,
    ],
    ["empty", { models: [] }, "pane", /Empty catalog/],
    ["ready", {}, "banner", /Catalog accessible/],
  ];

  it.each(cases)(
    "adds the warning without ▲ and its effect in the %s state",
    async (_row, overrides, where, marker) => {
      const h = harness(
        unknownState(overrides, where === "banner" ? [hostModel] : []),
      );
      await h.open();
      const rows = (): string[] =>
        where === "pane"
          ? pane(h.root()).split("\n")
          : shownRows(h.root(), "modelscout-banner");
      await vi.waitFor(() =>
        expect(cardText(rows())).toContain(`${WARNING} ${EFFECT}`),
      );
      expect(
        `${line(h.root(), "modelscout-status")}\n${pane(h.root())}`,
      ).toMatch(marker);
      expect(rows().join("\n")).not.toContain("▲ Unknown probe");
    },
  );

  it("adds ▲ unknown probe to the ready status line in the warning color", async () => {
    const h = harness(unknownState({}));
    await h.open();
    await vi.waitFor(() =>
      expect(line(h.root(), "modelscout-status")).toMatch(
        /^● Catalog accessible · ▲ unknown probe · key "Laptop" · 1 model · checked/,
      ),
    );
    expect(
      statusChunks(h.root()).find((chunk) => chunk.text === "▲ unknown probe")
        ?.fg,
    ).toEqual(color("warning"));
  });

  it("keeps ▲ unknown probe and drops the check age when the status line is too narrow", async () => {
    const h = harness(
      unknownState({ lastAttemptAt: new Date().toISOString() }),
    );
    h.context.renderer.terminalWidth = 80;
    h.context.renderer.terminalHeight = 24;
    await h.open();
    // The whole line takes 82 columns and 72 fit; the warning outlasts the other parts.
    await vi.waitFor(() =>
      expect(line(h.root(), "modelscout-status")).toBe(
        '● Catalog accessible · ▲ unknown probe · key "Laptop" · 1 model',
      ),
    );
  });

  it("shows the warning next to the configured-headers notice", async () => {
    const h = harness(unknownState({ credentialSource: "headers" }));
    await h.open();
    const banner = (): string =>
      cardText(shownRows(h.root(), "modelscout-banner"));
    await vi.waitFor(() => expect(banner()).toContain(WARNING));
    expect(banner()).toContain(
      "Discovery uses the provider's configured headers, not the connected key.",
    );
  });

  it("leaves the warning out until the result belongs to the current key", async () => {
    const h = harness(unknownState({ credentialEpoch: 2 }));
    await openedAt(h, /Waiting for discovery/);
    const shown = [
      line(h.root(), "modelscout-status"),
      pane(h.root()),
      ...shownRows(h.root(), "modelscout-banner"),
    ].join("\n");
    expect(shown).not.toMatch(/unknown probe/i);
  });
});

describe("a held record", () => {
  const shownRows = (root: unknown, id: string): string[] =>
    (findNodeById(root, id)?.children ?? [])
      .filter(visible)
      .map((child) => textOf(child).trimEnd());
  /** Card rows as running text: the bar dropped and wrapped rows joined. */
  const cardText = (rows: readonly string[]): string =>
    rows
      .map((row) => row.replace(/^▌ ?/, ""))
      .join(" ")
      .replace(/\s+/g, " ");

  it("says OpenCode has not finished loading and that a restart refreshes models, in place of the list", async () => {
    const h = harness({
      ...READY,
      catalog: payload(
        record({
          held: true,
          lastGoodAt: null,
          models: [],
          resultEpoch: null,
        }),
      ),
      hostModels: [],
    });
    await openedAt(h, /Restart OpenCode to refresh models/);
    expect(line(h.root(), "modelscout-status")).toMatch(
      /^▲ Waiting for OpenCode to finish loading · key "Laptop"(?! · \d+ models?)/,
    );
    expect(cardText(pane(h.root()).split("\n"))).toContain(
      "OpenCode has not reported that its plugins finished loading, so Model Scout sends no requests.",
    );
    expect(pane(h.root())).not.toMatch(/Checking|Waiting for discovery/);
  });

  it("keeps the stored models listed under the notice", async () => {
    const h = harness({ ...READY, catalog: payload(record({ held: true })) });
    await h.open();
    await vi.waitFor(() =>
      expect(line(h.root(), "modelscout-status")).toMatch(
        /^▲ Waiting for OpenCode to finish loading · key "Laptop" · 1 model/,
      ),
    );
    expect(cardText(shownRows(h.root(), "modelscout-banner"))).toContain(
      "Restart OpenCode to refresh models",
    );
    expect(pane(h.root())).toContain("Claude Haiku");
  });
});

describe("copy notice", () => {
  it("wraps a copied link onto the rows below instead of cutting it", async () => {
    const h = harness();
    h.context.renderer.terminalWidth = 80;
    await openedAt(h, /Connect an Actualyze API key/);
    h.press("y");
    const url = "https://app.actualyze.ai/account/settings?tab=security";
    expect(line(h.root(), "modelscout-notice")).toBe("Copy sent to terminal:");
    const banner = findNodeById(h.root(), "modelscout-banner");
    const shown = (banner?.children ?? [])
      .filter(visible)
      .map((child) => textOf(child).trimEnd());
    expect(shown).toContain(url);
  });
});

describe("small terminals", () => {
  const size = (h: Harness, columns: number, rows: number): void => {
    h.context.renderer.terminalWidth = columns;
    h.context.renderer.terminalHeight = rows;
  };
  const shownLines = (root: unknown, id: string): string[] =>
    (findNodeById(root, id)?.children ?? [])
      .filter(visible)
      .map((child) => textOf(child).trimEnd());

  it("shows the text to select when OSC 52 is unavailable, even at 80x16", async () => {
    const h = harness(READY);
    size(h, 80, 16);
    h.context.renderer.isOsc52Supported.mockReturnValue(false);
    await h.open();
    await vi.waitFor(() =>
      expect(line(h.root(), "modelscout-status")).toMatch(/Catalog accessible/),
    );
    h.press("y");
    expect(line(h.root(), "modelscout-notice")).toMatch(
      /select the text below/,
    );
    expect(shownLines(h.root(), "modelscout-banner")).toContain(
      "actualyze/claude-haiku",
    );
  });

  it("keeps a list row under a four-line copied ID at 80x16", async () => {
    const id = `long-${"x".repeat(270)}`;
    const h = harness({
      ...READY,
      catalog: payload(record({ models: [{ ...modelRecord, id }] })),
      hostModels: [{ ...hostModel, id }],
    });
    size(h, 80, 16);
    h.context.renderer.isOsc52Supported.mockReturnValue(false);
    await h.open();
    await vi.waitFor(() =>
      expect(line(h.root(), "modelscout-status")).toMatch(/Catalog accessible/),
    );
    h.press("y");
    expect(line(h.root(), "modelscout-notice")).toMatch(
      /select the text below/,
    );
    const banner = shownLines(h.root(), "modelscout-banner");
    expect(banner[0]).toBe(`actualyze/${id}`.slice(0, 72));
    const rows = shownLines(h.root(), "modelscout-list").filter(
      (row) => row.length > 0,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    // The body that holds the list keeps a row, and the summary its own.
    expect(findNodeById(h.root(), "modelscout-body")?.props?.height).toBe(1);
    expect(visible(findNodeById(h.root(), "modelscout-summary"))).toBe(true);
  });

  it("scrolls an overflowing card with the movement keys", async () => {
    const h = harness();
    size(h, 80, 20);
    await openedAt(h, /Connect an Actualyze API key/);
    const before = pane(h.root()).split("\n");
    expect(before.at(-1)).toMatch(/^↓ \d+ more$/);
    const down = h.press("down");
    expect(down.preventDefault).toHaveBeenCalled();
    const after = pane(h.root()).split("\n");
    expect(after[0]).toMatch(/^↑ /);
    h.press("end");
    expect(pane(h.root())).toMatch(/background service\./);
    h.press("?");
    expect(pane(h.root())).toMatch(
      /scroll the card when it runs past the dialog/,
    );
  });

  it("shows every card key exactly once across the footer and the card at 80x20", async () => {
    const h = harness();
    size(h, 80, 20);
    await openedAt(h, /Connect an Actualyze API key/);
    // The card's action row is its last line; scroll to it.
    h.press("end");
    const footer = line(h.root(), "modelscout-footer");
    const row = pane(h.root()).split("\n").at(-1) ?? "";
    const both = `${footer}\n${row}`;
    for (const hint of [
      "connect key k",
      "copy link y",
      "links l",
      "connections c",
      "all providers b",
    ])
      expect(both.split(hint).length - 1, hint).toBe(1);
    // Not every card key fits the footer, so the scroll hint gives way.
    expect(footer).not.toMatch(/scroll/);
  });

  it("adds the scroll hint last, only when every card key fits the footer", async () => {
    const h = harness();
    size(h, 120, 16);
    await openedAt(h, /Connect an Actualyze API key/);
    expect(pane(h.root()).split("\n").at(-1)).toMatch(/^↓ \d+ more$/);
    expect(line(h.root(), "modelscout-footer")).toMatch(
      /all providers b {2}scroll ↑↓ {2}keys \?/,
    );
  });

  it("leaves the movement keys alone and the footer quiet when the card fits", async () => {
    const h = harness();
    await openedAt(h, /Connect an Actualyze API key/);
    expect(line(h.root(), "modelscout-footer")).not.toMatch(/scroll/);
    expect(h.press("down").preventDefault).not.toHaveBeenCalled();
  });

  it("reaches every line of the key list at 80x16", async () => {
    /** Every row the key list shows while scrolling from top to end. */
    const scrolled = async (rows: number): Promise<Set<string>> => {
      const h = harness(READY);
      size(h, 80, rows);
      await h.open();
      await vi.waitFor(() =>
        expect(line(h.root(), "modelscout-status")).toMatch(
          /Catalog accessible/,
        ),
      );
      h.press("?");
      const seen = new Set<string>();
      for (let step = 0; step < 80; step += 1) {
        for (const row of pane(h.root()).split("\n"))
          if (!/^[↑↓] /.test(row)) seen.add(row);
        h.press("down");
      }
      return seen;
    };
    // At 80x40 every entry fits whole between the indicators, so scrolling
    // shows every line; the same width wraps the same lines at 80x16.
    const reference = await scrolled(40);
    const small = await scrolled(16);
    expect(reference.size).toBeGreaterThan(10);
    for (const row of reference) expect(small).toContain(row);
  });
});

describe("card action row", () => {
  const revoked: State = {
    ...READY,
    catalog: payload(
      record({
        lastGoodAt: null,
        models: [],
        failure: { kind: "unauthorized", at: AT, httpStatus: 401 },
      }),
    ),
    hostModels: [],
  };

  it("is left out when the footer fits every key", async () => {
    const h = harness(revoked);
    await openedAt(h, /Actualyze did not accept this key/);
    const card = pane(h.root()).split("\n");
    // Title and body only; no spacer, no action row.
    expect(card.at(-1)).toMatch(/Actualyze environment\.$/);
    expect(line(h.root(), "modelscout-footer")).toMatch(
      /^another key k {2}retry r {2}copy link y {2}links l {2}connections c {2}all providers b {2}keys \?/,
    );
  });

  it("lists only the keys the footer cannot fit, in footer order", async () => {
    const h = harness(revoked);
    h.context.renderer.terminalWidth = 80;
    h.context.renderer.terminalHeight = 24;
    await openedAt(h, /Actualyze did not accept this key/);
    const footer = line(h.root(), "modelscout-footer");
    expect(footer).toMatch(
      /^another key k {2}retry r {2}copy link y {2}links l {2}keys \?/,
    );
    const card = pane(h.root()).split("\n");
    expect(card.at(-2)).toBe("▌");
    expect(card.at(-1)).toBe("▌ connections c  all providers b");
    expect(footer).not.toMatch(/connections|all providers/);
  });

  it("titles the empty card Empty catalog, apart from the status line", async () => {
    const h = harness({
      ...READY,
      catalog: payload(record({ models: [] })),
      hostModels: [],
    });
    await openedAt(h, /Empty catalog/);
    expect(line(h.root(), "modelscout-status")).toMatch(
      /^▲ No models for this key/,
    );
    expect(pane(h.root())).not.toMatch(/No models for this key/);
  });
});

describe("key list at 80x24", () => {
  it("scrolls by whole entries and counts entries in its more lines", async () => {
    const h = harness(READY);
    h.context.renderer.terminalWidth = 80;
    h.context.renderer.terminalHeight = 24;
    await h.open();
    await vi.waitFor(() =>
      expect(line(h.root(), "modelscout-status")).toMatch(/Catalog accessible/),
    );
    h.press("?");
    /** Entries shown (rows that start with a key) and the hidden counts. */
    const read = () => {
      const rows = pane(h.root())
        .split("\n")
        .filter((row) => row.length > 0);
      const count = (pattern: RegExp): number =>
        Number(pattern.exec(rows.join("\n"))?.[1] ?? 0);
      const body = rows.filter(
        (row, index) => index > 0 && !/^[↑↓] \d+ more$/.test(row),
      );
      return {
        rows,
        shown: body.filter((row) => /^\S/.test(row)).length,
        above: count(/^↑ (\d+) more$/m),
        below: count(/^↓ (\d+) more$/m),
      };
    };
    /** The "/" entry wraps to two lines; it never shows without its second. */
    const whole = (rows: string[]): boolean => {
      const search = rows.findIndex((row) => /^\/ +search name/.test(row));
      return search < 0 || /returns to the list/.test(rows[search + 1] ?? "");
    };

    const top = read();
    expect(top.rows[0]).toMatch(/^Keys · Actualyze/);
    expect(top.below).toBeGreaterThan(0);
    expect(whole(top.rows)).toBe(true);

    for (let step = 0; step < 3; step += 1) h.press("down");
    const middle = read();
    expect(middle.rows[0]).toMatch(/^Keys · Actualyze/);
    expect(middle.above).toBe(3);
    expect(whole(middle.rows)).toBe(true);

    h.press("end");
    const end = read();
    expect(end.below).toBe(0);
    expect(whole(end.rows)).toBe(true);
    // Counts are entries: every view accounts for the same entries.
    const total = top.shown + top.below;
    expect(middle.above + middle.shown + middle.below).toBe(total);
    expect(end.above + end.shown).toBe(total);
  });
});

describe("cards", () => {
  it("offers retry r on the server-unavailable card and reads the catalog again with it", async () => {
    const h = harness();
    h.catalog.mockRejectedValue({ type: "rpc.unavailable", message: "down" });
    await openedAt(h, /server half did not answer/);
    expect(line(h.root(), "modelscout-footer")).toMatch(/retry r/);
    const reads = h.catalog.mock.calls.length;
    const event = h.press("r");
    expect(event.preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(h.catalog.mock.calls.length).toBe(reads + 1));
  });

  it("explains a 403 without guessing its cause", async () => {
    const h = harness({
      ...READY,
      catalog: payload(
        record({
          lastGoodAt: null,
          models: [],
          failure: { kind: "forbidden", at: AT, httpStatus: 403 },
        }),
      ),
      hostModels: [],
    });
    await openedAt(h, /refused the model list request/);
    const text = pane(h.root());
    expect(text).toMatch(/permissions and model access/);
    expect(text).not.toMatch(/read-only/i);
  });

  it("sizes the dialog to a card and grows it to full height for the list, and back", async () => {
    const h = harness();
    await openedAt(h, /Connect an Actualyze API key/);
    const cardHeight = rootHeight(h.root());
    expect(typeof cardHeight).toBe("number");
    expect(cardHeight as number).toBeLessThan(FULL_HEIGHT);
    const card = pane(h.root()).split("\n");
    // The pane shows the card's lines and nothing more; the body adds the
    // one blank row before the footer.
    expect(card.at(-1)).not.toBe("");
    const body = findNodeById(h.root(), "modelscout-body")?.props?.height;
    expect(body).toBe(card.length + 1);

    h.setState(READY);
    h.emitRpc("updated");
    await vi.waitFor(() => expect(rootHeight(h.root())).toBe(FULL_HEIGHT));

    h.setState(NO_KEY);
    h.emitRpc("updated");
    await vi.waitFor(() => expect(rootHeight(h.root())).toBe(cardHeight));
  });
});

// ── A run's provider ────────────────────────────────────────────────────

const RUN_ID = "actualyze-start";

/**
 * The provider a run of Actualyze Desktop or Atlas puts its models on;
 * OpenCode then lists no `actualyze` provider, only its integration.
 */
const runProvider: HostProvider = {
  id: RUN_ID,
  name: "Actualyze",
  package: "@opencode/ai/providers/openai-compatible",
  settings: {
    baseURL: "https://app.actualyze.ai/openai/v1",
    probe: "actualyze",
  },
};

const runModel: HostModel = {
  ...hostModel,
  id: "claude-sonnet",
  providerID: RUN_ID,
  name: "Claude Sonnet",
};

function runRecord(
  overrides: Partial<CatalogProviderRecord> = {},
): CatalogProviderRecord {
  return record({
    id: RUN_ID,
    models: [{ ...modelRecord, id: "claude-sonnet" }],
    ...overrides,
  });
}

const ENV_KEY = { type: "env", name: "ACTUALYZE_API_KEY" };
const LAPTOP_KEY = {
  type: "credential",
  id: "c1",
  label: "Laptop",
  method: "key",
};

/** The plugin's own integration. */
function ownIntegration(
  connections: IntegrationRow["connections"],
): IntegrationRow {
  return {
    id: "actualyze",
    name: "Actualyze",
    methods: [{ type: "key" }, { type: "env", names: ["ACTUALYZE_API_KEY"] }],
    connections,
  };
}

/** The integration OpenCode registers for a Desktop run's provider. */
const RUN_INTEGRATION: IntegrationRow = {
  id: RUN_ID,
  name: "Actualyze",
  methods: [
    { type: "key", label: "Manually enter API Key" },
    { type: "env", names: ["ACTUALYZE_API_KEY"] },
  ],
  connections: [ENV_KEY],
};

const DESKTOP: State = {
  connected: true,
  catalog: payload(runRecord()),
  hostProviders: [runProvider],
  hostModels: [runModel],
  integrations: [RUN_INTEGRATION, ownIntegration([ENV_KEY])],
};

/** An Atlas (V1) run: the key is in the run provider's settings.apiKey. */
const ATLAS: State = {
  ...DESKTOP,
  connected: false,
  catalog: payload(runRecord({ credentialSource: "settings" })),
  integrations: [
    {
      id: RUN_ID,
      name: "Actualyze",
      methods: [{ type: "key", label: "Manually enter API Key" }],
      connections: [],
    },
    ownIntegration([ENV_KEY]),
  ],
};

/** Probed for actualyze and on the actualyze integration, so k is allowed. */
const alias: HostProvider & { readonly integrationID: string } = {
  id: "team-actualyze",
  name: "Team Actualyze",
  package: "@opencode/ai/providers/openai-compatible",
  integrationID: "actualyze",
  settings: {
    baseURL: "https://app.actualyze.ai/openai/v1",
    probe: "actualyze",
  },
};

const aliasModel: HostModel = {
  ...hostModel,
  id: "claude-opus",
  providerID: alias.id,
  name: "Claude Opus",
};

/** The pane as running text: card bars dropped and wrapped rows joined. */
function paneText(root: unknown): string {
  return pane(root)
    .split("\n")
    .map((row) => row.replace(/^▌ ?/, ""))
    .join(" ")
    .replace(/\s+/g, " ");
}

function status(h: Harness): string {
  return line(h.root(), "modelscout-status");
}

async function readyAt(h: Harness, pattern: RegExp): Promise<void> {
  await h.open();
  await vi.waitFor(() => expect(status(h)).toMatch(pattern));
}

describe("a Desktop run", () => {
  it("lists the run's models as accessible, with the key from ACTUALYZE_API_KEY", async () => {
    const h = harness(DESKTOP);
    await readyAt(
      h,
      /^● Catalog accessible · key ACTUALYZE_API_KEY · 1 model · checked/,
    );
    expect(pane(h.root())).toContain("Claude Sonnet");
  });

  it("names the connection of the run provider's own integration", async () => {
    const h = harness({
      ...DESKTOP,
      integrations: [
        {
          ...RUN_INTEGRATION,
          connections: [{ ...LAPTOP_KEY, id: "c2", label: "Desktop" }],
        },
        ownIntegration([LAPTOP_KEY]),
      ],
    });
    await readyAt(h, /^● Catalog accessible · key "Desktop" · 1 model/);
  });

  it("keeps k off although the run's integration offers a key method", async () => {
    const h = harness(DESKTOP);
    await readyAt(h, /^● Catalog accessible/);
    h.press("k");
    await settle();
    expect(h.dialog.prompt).not.toHaveBeenCalled();
    expect(h.connectKey).not.toHaveBeenCalled();
  });

  it("refreshes the run's provider with r", async () => {
    const h = harness(DESKTOP);
    await readyAt(h, /^● Catalog accessible/);
    h.press("r");
    await vi.waitFor(() => expect(h.refresh).toHaveBeenCalledOnce());
    expect(h.refresh.mock.calls[0]?.[0]).toEqual({ providerID: RUN_ID });
  });

  it("names the run provider's base URL setting on a failure card", async () => {
    const h = harness({
      ...DESKTOP,
      catalog: payload(
        runRecord({
          lastGoodAt: null,
          models: [],
          failure: { kind: "not-found", at: AT, httpStatus: 404 },
        }),
      ),
      hostModels: [],
    });
    await openedAt(h, /The base URL may be wrong/);
    expect(paneText(h.root())).toContain(
      "The setting providers.actualyze-start.settings.baseURL should end in /openai/v1.",
    );
  });

  it("names the run provider's base URL setting when the links screen has no links", async () => {
    const h = harness({
      ...DESKTOP,
      hostProviders: [
        {
          ...runProvider,
          settings: { baseURL: "ftp://gw.example/v1", probe: "actualyze" },
        },
      ],
    });
    await readyAt(h, /^● Catalog accessible/);
    h.press("l");
    await vi.waitFor(() =>
      expect(paneText(h.root())).toContain(
        "No app links: providers.actualyze-start.settings.baseURL is not an http(s) URL.",
      ),
    );
  });

  it("lists the run's models when another definition of actualyze exists", async () => {
    const h = harness({ ...DESKTOP, catalog: payload(runRecord(), "foreign") });
    await readyAt(h, /^● Catalog accessible · key ACTUALYZE_API_KEY/);
    expect(pane(h.root())).toContain("Claude Sonnet");
    expect(pane(h.root())).not.toMatch(/Another definition of actualyze/);
  });
});

describe("an Atlas run", () => {
  it("lists the run's models with the key from settings.apiKey and offers no key to connect", async () => {
    const h = harness(ATLAS);
    await readyAt(h, /^● Catalog accessible · key settings\.apiKey · 1 model/);
    expect(pane(h.root())).toContain("Claude Sonnet");
    expect(pane(h.root())).not.toMatch(/Connect an Actualyze API key/);
  });
});

describe("the failure card's key source", () => {
  const SERVER_ERROR: Partial<CatalogProviderRecord> = {
    lastGoodAt: null,
    models: [],
    failure: { kind: "server-error", at: AT, httpStatus: 503 },
  };
  // Only a provider on the actualyze integration takes a key from k.
  const cases: Array<[string, State, string, boolean]> = [
    [
      "actualyze with ACTUALYZE_API_KEY",
      {
        connected: true,
        catalog: payload(record(SERVER_ERROR)),
        hostProviders: [actualyzeProvider],
        hostModels: [],
        integrations: [ownIntegration([ENV_KEY])],
      },
      "The key comes from ACTUALYZE_API_KEY on the background service; a key connected with k takes precedence.",
      true,
    ],
    [
      "actualyze with settings.apiKey",
      {
        ...NO_KEY,
        catalog: payload(
          record({ ...SERVER_ERROR, credentialSource: "settings" }),
        ),
        hostProviders: [actualyzeProvider],
      },
      "The key comes from settings.apiKey in opencode.json; a key connected with k takes precedence.",
      true,
    ],
    [
      "an alias on the actualyze integration with settings.apiKey",
      {
        ...NO_KEY,
        catalog: payload(
          record({
            ...SERVER_ERROR,
            id: alias.id,
            credentialSource: "settings",
          }),
        ),
        hostProviders: [alias],
      },
      "The key comes from settings.apiKey in opencode.json; a key connected with k takes precedence.",
      true,
    ],
    [
      "a Desktop run",
      { ...DESKTOP, catalog: payload(runRecord(SERVER_ERROR)), hostModels: [] },
      "The key comes from ACTUALYZE_API_KEY in OpenCode's environment.",
      false,
    ],
    [
      "an Atlas run",
      {
        ...ATLAS,
        catalog: payload(
          runRecord({ ...SERVER_ERROR, credentialSource: "settings" }),
        ),
        hostModels: [],
      },
      "The key comes from providers.actualyze-start.settings.apiKey.",
      false,
    ],
  ];

  it.each(cases)(
    "says where the key of %s comes from",
    async (_name, state, note, pointsAtK) => {
      const h = harness(state);
      await openedAt(h, /Actualyze failed to list models/);
      const text = paneText(h.root());
      expect(text).toContain(note);
      expect(text.split("The key comes from").length - 1).toBe(1);
      expect(/\bk\b/.test(text)).toBe(pointsAtK);
    },
  );
});

describe("actualyze listed beside a run's provider", () => {
  it("shows actualyze's models and key, and keeps k", async () => {
    const h = harness({
      connected: true,
      catalog: payload([runRecord(), record()]),
      // The run's provider comes first, so a first-match choice would pick it.
      hostProviders: [runProvider, actualyzeProvider],
      hostModels: [runModel, hostModel],
      integrations: [RUN_INTEGRATION, ownIntegration([LAPTOP_KEY])],
    });
    await readyAt(h, /^● Catalog accessible · key "Laptop" · 1 model/);
    expect(pane(h.root())).toContain("Claude Haiku");
    expect(pane(h.root())).not.toContain("Claude Sonnet");
    h.press("k");
    expect(h.dialog.prompt).toHaveBeenCalledOnce();
  });
});

describe("opening", () => {
  it("waits for the first read of the stores and shows the dialog once, on the provider it names", async () => {
    const h = harness(DESKTOP);
    const read = deferred<void>();
    h.context.data.location.provider.sync.mockReturnValueOnce(read.promise);
    const opening = h.open();
    await drain();
    expect(h.dialog.show).not.toHaveBeenCalled();
    read.resolve();
    await opening;
    await vi.waitFor(() =>
      expect(status(h)).toMatch(
        /^● Catalog accessible · key ACTUALYZE_API_KEY/,
      ),
    );
    expect(h.dialog.show).toHaveBeenCalledOnce();
  });

  it("ends the session and shows nothing when the location changes before the first read ends", async () => {
    const h = harness(DESKTOP);
    const read = deferred<void>();
    h.context.data.location.provider.sync.mockReturnValueOnce(read.promise);
    const opening = h.open();
    await settle();
    h.context.location = { directory: "/elsewhere" };
    read.resolve();
    await opening;
    expect(h.dialog.show).not.toHaveBeenCalled();
    expect(h.stopFacts).toHaveBeenCalledTimes(4);
  });

  describe("when the first read takes longer than 1 s", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Open with the first read held by `read`, and let the 1 s wait run out. */
    async function openPastTheWait(
      h: Harness,
      read: Promise<void>,
    ): Promise<void> {
      h.context.data.location.provider.sync.mockReturnValueOnce(read);
      const opening = h.open();
      await vi.advanceTimersByTimeAsync(999);
      expect(h.dialog.show).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await opening;
      expect(h.dialog.show).toHaveBeenCalled();
    }

    it("shows the dialog again on the provider the late read names, and the session keeps working", async () => {
      const h = harness(DESKTOP);
      const read = deferred<void>();
      await openPastTheWait(h, read.promise);
      expect(h.dialog.show).toHaveBeenCalledOnce();
      // Before any read the dialog shows actualyze, which a run does not list.
      await vi.waitFor(() =>
        expect(pane(h.root())).toMatch(/Waiting for discovery/),
      );
      const first = h.root();

      read.resolve();
      await vi.waitFor(() => expect(h.dialog.show).toHaveBeenCalledTimes(2));
      await vi.waitFor(() =>
        expect(status(h)).toMatch(
          /^● Catalog accessible · key ACTUALYZE_API_KEY · 1 model/,
        ),
      );
      expect(pane(h.root())).toContain("Claude Sonnet");
      expect(h.stopFacts).not.toHaveBeenCalled();
      // The dialog it replaced never painted the run's facts over actualyze.
      expect(line(first, "modelscout-status")).not.toContain(
        "ACTUALYZE_API_KEY",
      );

      // The session still follows OpenCode's events: a later read names
      // actualyze, and k connects a key to it.
      h.setState(READY);
      h.emitFact("provider.updated");
      await vi.waitFor(() => expect(h.dialog.show).toHaveBeenCalledTimes(3));
      await vi.waitFor(() =>
        expect(status(h)).toMatch(/^● Catalog accessible · key "Laptop"/),
      );
      await submitKey(h);
      expect(h.connectKey.mock.calls[0]?.[0]).toMatchObject({
        integrationID: "actualyze",
      });
      expect(h.stopFacts).not.toHaveBeenCalled();
    });

    it("shows the dialog again when the late read ends while the dialog opens", async () => {
      const h = harness(DESKTOP);
      const read = deferred<void>();
      // The opening dialog subscribes to the server's events before its
      // modules load; the read ends at that moment. This covers a read that
      // ends while the dialog opens only as long as the browser keeps that
      // order.
      const rpc = h.context.client.rpc.getMockImplementation();
      h.context.client.rpc.mockImplementationOnce(() => {
        read.resolve();
        if (!rpc) throw new Error("rpc has no implementation");
        return rpc();
      });
      await openPastTheWait(h, read.promise);
      await vi.waitFor(() => expect(h.dialog.show).toHaveBeenCalledTimes(2));
      await vi.waitFor(() =>
        expect(status(h)).toMatch(
          /^● Catalog accessible · key ACTUALYZE_API_KEY/,
        ),
      );
      await drain();
      expect(h.dialog.show).toHaveBeenCalledTimes(2);
      expect(h.stopFacts).not.toHaveBeenCalled();
    });

    it("shows nothing again when the late read names the provider already shown", async () => {
      const h = harness(READY);
      const read = deferred<void>();
      await openPastTheWait(h, read.promise);
      read.resolve();
      // The read has landed once the status names the connected key.
      await vi.waitFor(() => expect(status(h)).toMatch(/key "Laptop"/));
      await drain();
      expect(h.dialog.show).toHaveBeenCalledOnce();
    });

    it("shows nothing again when the dialog closed before the late read ended", async () => {
      const h = harness(DESKTOP);
      const read = deferred<void>();
      await openPastTheWait(h, read.promise);
      h.dialog.clear();
      expect(h.stopFacts).toHaveBeenCalledTimes(4);

      read.resolve();
      await vi.waitFor(() =>
        expect(h.context.data.location.integration.list).toHaveBeenCalled(),
      );
      await drain();
      expect(h.dialog.show).toHaveBeenCalledOnce();
      expect(h.current()).toBeUndefined();
    });

    it("ends the session and shows nothing when the location changes before the wait runs out", async () => {
      const h = harness(DESKTOP);
      const read = deferred<void>();
      h.context.data.location.provider.sync.mockReturnValueOnce(read.promise);
      const opening = h.open();
      await vi.advanceTimersByTimeAsync(500);
      h.context.location = { directory: "/elsewhere" };
      await vi.advanceTimersByTimeAsync(500);
      await opening;
      expect(h.dialog.show).not.toHaveBeenCalled();
      expect(h.stopFacts).toHaveBeenCalledTimes(4);

      // The read that ends afterwards opens nothing either.
      read.resolve();
      await vi.waitFor(() =>
        expect(h.context.data.location.integration.list).toHaveBeenCalled(),
      );
      await drain();
      expect(h.dialog.show).not.toHaveBeenCalled();
    });
  });
});

describe("a read after the location changed", () => {
  it("ends the session and closes the dialog instead of showing it on the provider the read names", async () => {
    const h = harness(DESKTOP);
    await readyAt(h, /^● Catalog accessible · key ACTUALYZE_API_KEY/);
    h.context.location = { directory: "/elsewhere" };
    h.setState(READY);
    h.emitFact("provider.updated");
    await vi.waitFor(() => expect(h.stopFacts).toHaveBeenCalledTimes(4));
    expect(h.dialog.show).toHaveBeenCalledOnce();
    expect(h.current()).toBeUndefined();
  });
});

describe("the no-key card", () => {
  it("on actualyze, offers k and copies the API Keys link", async () => {
    const h = harness();
    await openedAt(h, /Connect an Actualyze API key/);
    expect(line(h.root(), "modelscout-footer")).toMatch(
      /^connect key k {2}copy link y {2}links l {2}connections c {2}all providers b/,
    );
    h.press("y");
    expect(h.copied).toHaveBeenLastCalledWith(
      "https://app.actualyze.ai/account/settings?tab=security",
    );
    h.press("k");
    expect(h.dialog.prompt).toHaveBeenCalledOnce();
  });

  it("on an alias on the actualyze integration, is actualyze's card with k and the API Keys link", async () => {
    const h = harness({
      ...NO_KEY,
      catalog: payload(
        record({
          id: alias.id,
          credentialSource: "none",
          lastGoodAt: null,
          models: [],
        }),
      ),
      hostProviders: [alias],
    });
    await openedAt(h, /Connect an Actualyze API key/);
    expect(pane(h.root())).not.toMatch(/No key for/);
    h.press("y");
    expect(h.copied).toHaveBeenLastCalledWith(
      "https://app.actualyze.ai/account/settings?tab=security",
    );
    h.press("k");
    expect(h.dialog.prompt).toHaveBeenCalledOnce();
  });

  it("on a run's provider, sends the member back to the launcher without k or a link to copy", async () => {
    const h = harness({
      ...DESKTOP,
      catalog: payload(
        runRecord({ credentialSource: "none", lastGoodAt: null, models: [] }),
      ),
      hostModels: [],
      // actualyze's own connection is not the run provider's key.
      integrations: [
        { ...RUN_INTEGRATION, connections: [] },
        ownIntegration([ENV_KEY]),
      ],
    });
    await openedAt(h, /No key for actualyze-start/);
    const text = paneText(h.root());
    expect(text).toContain(
      "A run that Actualyze Desktop or Atlas starts gets its key from them. Start the run again there.",
    );
    expect(text).toContain(
      "For a provider in your own settings, set providers.actualyze-start.settings.apiKey or connect a key under c.",
    );
    expect(text).not.toMatch(/Connect an Actualyze API key/);
    expect(status(h)).toMatch(/^○ Not connected/);
    expect(line(h.root(), "modelscout-footer")).toMatch(
      /^links l {2}connections c {2}all providers b {2}keys \?/,
    );

    h.press("k");
    h.press("y");
    await settle();
    expect(h.dialog.prompt).not.toHaveBeenCalled();
    expect(h.copied).not.toHaveBeenCalled();
    h.press("c");
    expect(h.dispatch).toHaveBeenCalledWith("provider.connect");
  });
});

describe("a key connected while the dialog shows an alias provider", () => {
  const aliasRecord = record({
    id: alias.id,
    credentialSource: "settings",
    credentialEpoch: 3,
    resultEpoch: 3,
    models: [{ ...modelRecord, id: "claude-opus" }],
  });

  it("leaves checking once the dialog shows actualyze with its own record", async () => {
    const h = harness({
      connected: false,
      catalog: payload(aliasRecord),
      hostProviders: [alias],
      hostModels: [aliasModel],
    });
    const save = deferred<void>();
    h.connectKey.mockReturnValueOnce(save.promise);
    await readyAt(h, /^● Catalog accessible · key settings\.apiKey · 1 model/);
    await submitKey(h);
    await vi.waitFor(() =>
      expect(pane(h.root())).toMatch(/OpenCode is storing the key/),
    );

    // The connected key lists actualyze, whose record has epochs of its own
    // in the same server instance.
    h.setState({
      connected: true,
      catalog: payload([
        aliasRecord,
        record({ credentialEpoch: 0, resultEpoch: 0 }),
      ]),
      hostProviders: [actualyzeProvider, alias],
      hostModels: [hostModel, aliasModel],
    });
    save.resolve();
    await vi.waitFor(() =>
      expect(status(h)).toMatch(
        /^● Catalog accessible · key "Laptop" · 1 model/,
      ),
    );
    expect(pane(h.root())).toContain("Claude Haiku");
    expect(pane(h.root())).not.toMatch(/Key saved/);
  });
});
