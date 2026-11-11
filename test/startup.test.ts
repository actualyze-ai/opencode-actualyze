import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTUALYZE_ENV, ACTUALYZE_PROBE_ID } from "../src/constants";
import {
  normalizeBaseURL,
  type DiscoveryResult,
  type DiscoveryTarget,
} from "../src/discover";
import {
  createStore,
  credentialKeys,
  targetKeys,
  type Binding,
} from "../src/store";
import {
  configDocuments,
  environmentCredential,
  readConfiguredEntries,
  startupDiscovery,
  stripJsonComments,
  substitute,
  type ConfiguredEntry,
} from "../src/startup";
import { createTransformState } from "../src/transform";
import { readOptions } from "../src/refresher";

const BASE = "http://127.0.0.1:9/openai/v1";

function providerJSON(
  id: string,
  settings: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({ providers: { [id]: { settings, ...extra } } });
}

let root: string;
let cwd: string;
let configHome: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "scout-startup-"));
  cwd = path.join(root, "project");
  configHome = path.join(root, "xdg-config");
  mkdirSync(path.join(cwd, ".opencode"), { recursive: true });
  mkdirSync(path.join(configHome, "opencode"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const sources = (env: Record<string, string | undefined> = {}) => ({
  env: { XDG_CONFIG_HOME: configHome, ...env },
  cwd,
  home: root,
});

describe("stripJsonComments", () => {
  it("removes line and block comments outside strings", () => {
    const text = `{
      // a comment
      "a": "http://x/y", /* block */ "b": "// not a comment", "c": "/* nor this */"
    }`;
    expect(JSON.parse(stripJsonComments(text))).toEqual({
      a: "http://x/y",
      b: "// not a comment",
      c: "/* nor this */",
    });
  });

  it("keeps escaped quotes inside strings", () => {
    expect(JSON.parse(stripJsonComments('{"a": "q\\"//x"}'))).toEqual({
      a: 'q"//x',
    });
  });

  it("drops trailing commas before a closing bracket, comments between included, and keeps commas inside strings", () => {
    const text = `{
      "list": [1, 2, // last
      ],
      "settings": { "apiKey": "a,b", "probe": "actualyze", /* end */ },
    }`;
    expect(JSON.parse(stripJsonComments(text))).toEqual({
      list: [1, 2],
      settings: { apiKey: "a,b", probe: "actualyze" },
    });
  });
});

describe("substitute", () => {
  it("replaces {env:NAME} and {file:path} anywhere in the text, a file path relative to the document's directory", () => {
    writeFileSync(path.join(cwd, "key.txt"), "from-file\n");
    const text =
      '{"baseURL": "https://{env:HOST}/openai/v1", "apiKey": "pre-{file:key.txt}"}';
    expect(JSON.parse(substitute(text, cwd, { HOST: "h.example" }))).toEqual({
      baseURL: "https://h.example/openai/v1",
      apiKey: "pre-from-file",
    });
  });

  it("substitutes a missing variable or an unreadable file as the empty string and leaves a token on a comment line alone", () => {
    const text =
      '{\n  // {file:nothing.txt}\n  "a": "{env:MISSING}", "b": "{file:nothing.txt}"\n}';
    expect(JSON.parse(stripJsonComments(substitute(text, cwd, {})))).toEqual({
      a: "",
      b: "",
    });
  });

  it("escapes a value that would break the JSON on the second pass", () => {
    const text = '{"a": "{env:P}"}';
    expect(JSON.parse(substitute(text, cwd, { P: 'C:\\x "q"' }))).toEqual({
      a: 'C:\\x "q"',
    });
  });
});

describe("configDocuments", () => {
  it("reads the global, OPENCODE_CONFIG, project, project .opencode and OPENCODE_CONFIG_CONTENT sources in OpenCode's order", () => {
    writeFileSync(
      path.join(configHome, "opencode", "opencode.json"),
      providerJSON("g", {}),
    );
    writeFileSync(
      path.join(cwd, ".opencode", "opencode.jsonc"),
      `// jsonc\n${providerJSON("d", {})}`,
    );
    writeFileSync(path.join(cwd, "opencode.json"), providerJSON("p", {}));
    const explicit = path.join(root, "explicit.json");
    writeFileSync(explicit, providerJSON("e", {}));
    const documents = configDocuments(
      sources({
        OPENCODE_CONFIG: explicit,
        OPENCODE_CONFIG_CONTENT: providerJSON("c", {}),
      }),
    );
    expect(documents.map((d) => Object.keys(d.providers)[0])).toEqual([
      "g",
      "e",
      "p",
      "d",
      "c",
    ]);
  });

  it("skips a file that is not JSON or has no providers", () => {
    writeFileSync(path.join(cwd, "opencode.json"), "{ not json");
    writeFileSync(
      path.join(configHome, "opencode", "opencode.json"),
      JSON.stringify({ model: "x" }),
    );
    expect(configDocuments(sources())).toEqual([]);
  });
});

describe("readConfiguredEntries", () => {
  it("keeps only an entry with the Actualyze probe, an http(s) baseURL and an apiKey", () => {
    const content = JSON.stringify({
      providers: {
        actualyze: {
          settings: { baseURL: BASE, apiKey: "k1", probe: ACTUALYZE_PROBE_ID },
        },
        "actualyze-claude": { settings: { baseURL: BASE, apiKey: "k1" } },
        auto: { settings: { baseURL: BASE, apiKey: "k1", probe: "auto" } },
        nokey: { settings: { baseURL: BASE, probe: ACTUALYZE_PROBE_ID } },
        badurl: {
          settings: {
            baseURL: "ftp://x",
            apiKey: "k",
            probe: ACTUALYZE_PROBE_ID,
          },
        },
        emptykey: {
          settings: {
            baseURL: BASE,
            apiKey: "{env:UNSET}",
            probe: ACTUALYZE_PROBE_ID,
          },
        },
      },
    });
    expect(
      readConfiguredEntries(sources({ OPENCODE_CONFIG_CONTENT: content })),
    ).toEqual<ConfiguredEntry[]>([
      {
        providerID: "actualyze",
        baseURL: BASE,
        apiKey: "k1",
        probe: ACTUALYZE_PROBE_ID,
      },
    ]);
  });

  it("resolves each document's substitutions against that document's own directory", () => {
    writeFileSync(path.join(configHome, "opencode", "key.txt"), "global-key\n");
    writeFileSync(path.join(cwd, "endpoint.txt"), `${BASE}\n`);
    writeFileSync(
      path.join(configHome, "opencode", "opencode.json"),
      providerJSON("actualyze", {
        baseURL: "http://global/v1",
        apiKey: "{file:key.txt}",
        probe: ACTUALYZE_PROBE_ID,
      }),
    );
    writeFileSync(
      path.join(cwd, "opencode.json"),
      providerJSON("actualyze", { baseURL: "{file:endpoint.txt}" }),
    );
    expect(readConfiguredEntries(sources())).toEqual([
      {
        providerID: "actualyze",
        baseURL: BASE,
        apiKey: "global-key",
        probe: ACTUALYZE_PROBE_ID,
      },
    ]);
  });

  it("lets a later source override an earlier one key by key and carries string headers; a trailing comma is accepted", () => {
    writeFileSync(
      path.join(configHome, "opencode", "opencode.json"),
      providerJSON(
        "actualyze",
        {
          baseURL: "http://global/v1",
          apiKey: "global-key",
          probe: ACTUALYZE_PROBE_ID,
        },
        { headers: { "x-team": "t", "x-num": 1 } },
      ),
    );
    writeFileSync(
      path.join(cwd, "opencode.json"),
      `{ "providers": { "actualyze": { "settings": { "baseURL": "${BASE}", }, }, }, }`,
    );
    expect(readConfiguredEntries(sources())).toEqual([
      {
        providerID: "actualyze",
        baseURL: BASE,
        apiKey: "global-key",
        probe: ACTUALYZE_PROBE_ID,
        headers: { "x-team": "t" },
      },
    ]);
  });

  it("lets the project file override the OPENCODE_CONFIG file, as the host does", () => {
    const explicit = path.join(root, "explicit.json");
    writeFileSync(
      explicit,
      providerJSON("actualyze", {
        baseURL: "http://stage/v1",
        apiKey: "k",
        probe: ACTUALYZE_PROBE_ID,
      }),
    );
    writeFileSync(
      path.join(cwd, "opencode.json"),
      providerJSON("actualyze", { baseURL: BASE }),
    );
    expect(
      readConfiguredEntries(sources({ OPENCODE_CONFIG: explicit }))[0]?.baseURL,
    ).toBe(BASE);
  });
});

describe("startupDiscovery", () => {
  const entry: ConfiguredEntry = {
    providerID: "actualyze",
    baseURL: BASE,
    apiKey: "k1",
    probe: ACTUALYZE_PROBE_ID,
  };
  const keysOf = (e: ConfiguredEntry) =>
    targetKeys({
      providerID: e.providerID,
      baseURL: normalizeBaseURL(e.baseURL),
      probe: e.probe,
      apiKey: e.apiKey,
      headers: e.headers,
    });
  const inventory = (ids: string[]) => ({
    modelListAttempt: "ready" as const,
    probeAttempt: "complete" as const,
    models: ids.map((id) => ({ id })),
    completedAt: "2026-11-10T00:00:00.000Z",
  });
  const ok =
    (ids: string[]) =>
    async (
      _target: DiscoveryTarget,
      _signal: AbortSignal,
    ): Promise<DiscoveryResult> => ({ ok: true, inventory: inventory(ids) });

  it("serves a stored binding for the entry's endpoint and key without any request", async () => {
    const store = createStore();
    const state = createTransformState();
    const keys = keysOf(entry);
    const stored: Binding = {
      key: keys.key,
      endpointKey: keys.endpointKey,
      providerID: "actualyze",
      credential: "settings",
      inventory: inventory(["gpt-4o"]),
    };
    store.seed(stored);
    const discover = vi.fn(ok([]));
    const outcomes = await startupDiscovery({
      entries: [entry],
      store,
      state,
      timeoutMs: 5000,
      discover,
    });
    expect(outcomes).toEqual([{ providerID: "actualyze", source: "stored" }]);
    expect(state.active.get("actualyze")).toBe(stored);
    expect(discover).not.toHaveBeenCalled();
  });

  it("discovers with the entry's own base URL and key, seeds the store, serves and persists the binding", async () => {
    const store = createStore();
    const state = createTransformState();
    const persist = vi.fn(async () => {});
    const discover = vi.fn(ok(["gpt-4o", "gpt-4o-mini"]));
    const outcomes = await startupDiscovery({
      entries: [entry],
      store,
      state,
      timeoutMs: 5000,
      discover,
      persist,
    });
    expect(outcomes).toEqual([
      { providerID: "actualyze", source: "discovered" },
    ]);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(discover.mock.calls[0]?.[0]).toEqual({
      providerID: "actualyze",
      baseURL: BASE,
      apiKey: "k1",
      probe: ACTUALYZE_PROBE_ID,
    });
    const keys = keysOf(entry);
    const served = store.served(keys.key);
    expect(served).toMatchObject({
      key: keys.key,
      endpointKey: keys.endpointKey,
      providerID: "actualyze",
      credential: "settings",
    });
    expect(state.active.get("actualyze")).toBe(served);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(served);
  });

  it("also seeds the binding under the integration's environment credential when the key is the environment key, so the first sync keeps it", async () => {
    const store = createStore();
    const state = createTransformState();
    const persist = vi.fn(async () => {});
    await startupDiscovery({
      entries: [entry],
      store,
      state,
      timeoutMs: 5000,
      integrationEnvKey: "k1",
      discover: vi.fn(ok(["gpt-4o"])),
      persist,
    });
    const keys = keysOf(entry);
    const credential = environmentCredential("k1");
    expect(credential).toMatch(/^integration:[0-9a-f]{64}$/);
    const integrationKey = credentialKeys(keys, credential).key;
    expect(store.served(integrationKey)).toBeUndefined();
    expect(store.verify(integrationKey, credential)).toBe(true);
    expect(store.served(integrationKey)).toMatchObject({
      key: integrationKey,
      endpointKey: keys.endpointKey,
      credential,
    });
    expect(state.active.get("actualyze")?.credential).toBe("settings");
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it("does not seed the integration credential when the environment key differs from the entry's key", async () => {
    const store = createStore();
    const state = createTransformState();
    await startupDiscovery({
      entries: [entry],
      store,
      state,
      timeoutMs: 5000,
      integrationEnvKey: "other",
      discover: vi.fn(ok(["gpt-4o"])),
    });
    const integrationKey = credentialKeys(
      keysOf(entry),
      environmentCredential("other"),
    ).key;
    expect(store.verify(integrationKey, environmentCredential("other"))).toBe(
      false,
    );
  });

  it("changes nothing on a failed or thrown discovery, and skips the request when the budget is 0", async () => {
    const store = createStore();
    const state = createTransformState();
    const failing = vi.fn(
      async (): Promise<DiscoveryResult> => ({
        ok: false,
        failure: "unreachable",
        modelListAttempt: "unreachable",
      }),
    );
    expect(
      await startupDiscovery({
        entries: [entry],
        store,
        state,
        timeoutMs: 5000,
        discover: failing,
      }),
    ).toEqual([
      { providerID: "actualyze", source: "failed", reason: "unreachable" },
    ]);
    const throwing = vi.fn(async (): Promise<DiscoveryResult> => {
      throw new Error("boom");
    });
    expect(
      await startupDiscovery({
        entries: [entry],
        store,
        state,
        timeoutMs: 5000,
        discover: throwing,
      }),
    ).toEqual([{ providerID: "actualyze", source: "failed", reason: "boom" }]);
    const skipped = vi.fn();
    expect(
      await startupDiscovery({
        entries: [entry],
        store,
        state,
        timeoutMs: 0,
        discover: skipped,
      }),
    ).toEqual([{ providerID: "actualyze", source: "skipped" }]);
    expect(skipped).not.toHaveBeenCalled();
    expect(state.active.size).toBe(0);
    expect(store.served(keysOf(entry).key)).toBeUndefined();
  });

  it("runs the entries concurrently, each with its own abort signal, so the wait is one budget", async () => {
    const store = createStore();
    const state = createTransformState();
    const started: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const discover = vi.fn(
      async (
        target: DiscoveryTarget,
        signal: AbortSignal,
      ): Promise<DiscoveryResult> => {
        expect(signal).toBeInstanceOf(AbortSignal);
        started.push(target.providerID);
        await gate;
        return { ok: true, inventory: inventory([`m-${target.providerID}`]) };
      },
    );
    const second: ConfiguredEntry = {
      ...entry,
      providerID: "actualyze-stage",
    };
    const pending = startupDiscovery({
      entries: [entry, second],
      store,
      state,
      timeoutMs: 1234,
      discover,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(["actualyze", "actualyze-stage"]);
    release?.();
    const outcomes = await pending;
    expect(outcomes.map((o) => o.source)).toEqual(["discovered", "discovered"]);
    expect(state.active.size).toBe(2);
  });
});

describe("readOptions startupTimeoutMs", () => {
  it("defaults to 5000, clamps to 1000 through 60000, and 0 or less disables", () => {
    expect(readOptions(undefined).startupTimeoutMs).toBe(5000);
    expect(readOptions({ startupTimeoutMs: 10 }).startupTimeoutMs).toBe(1000);
    expect(readOptions({ startupTimeoutMs: 99_999 }).startupTimeoutMs).toBe(
      60_000,
    );
    expect(readOptions({ startupTimeoutMs: 0 }).startupTimeoutMs).toBe(0);
    expect(readOptions({ startupTimeoutMs: -5 }).startupTimeoutMs).toBe(0);
    expect(readOptions({ startupTimeoutMs: "x" }).startupTimeoutMs).toBe(5000);
  });

  it("names the integration's environment variable the double seed keys on", () => {
    expect(ACTUALYZE_ENV).toBe("ACTUALYZE_API_KEY");
  });
});
