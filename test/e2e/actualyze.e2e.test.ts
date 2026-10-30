/**
 * Embedded-host E2E for the built-in Actualyze provider. Each scenario runs
 * its own host with a different config and environment.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Plugin } from "@opencode/plugin";
import type { OpenCode } from "@opencode/sdk";
import plugin from "../../src/server";
import { actualyzeProviderInfo } from "../../src/actualyze";
import { validateCatalogPayload } from "../../src/catalog-evidence";
import { REPLACEMENT_WAIT_MS } from "../../src/refresher";
import { ModelScoutRpc } from "../../src/rpc";

const PRODUCTION_ORIGIN = "https://app.actualyze.ai";
const PRODUCTION_BASE_URL = `${PRODUCTION_ORIGIN}/openai/v1`;
const ENV_ONLY_KEY = "actualyze-env-only-key";
const ENV_KEY = "actualyze-env-key";
const SETTINGS_KEY = "actualyze-settings-key";
const CONNECTED_KEY = "actualyze-connected-key";
const SHADOWED_SETTINGS_KEY = "actualyze-shadowed-settings-key";
const STORED_KEY = "actualyze-stored-key";
const ZERO_CONFIG_KEY = "actualyze-zero-config-key";
const SLOW_LOAD_KEY = "actualyze-slow-load-key";
const RUN_ORIGIN_KEY = "actualyze-run-origin-key";
const RUN_ORIGIN_OVERRIDE_KEY = "actualyze-run-origin-override-key";
const RELOAD_ENV_KEY = "actualyze-reload-env-key";
const RELOAD_KEY = "actualyze-reload-connected-key";
const HOLD_ENV_KEY = "actualyze-hold-env-key";
const HOLD_KEY = "actualyze-hold-connected-key";
const INTEGRATION_ID = "actualyze";
/** How long the plugin listed after scout takes to set up. */
const SLOW_SETUP_MS = 1_000;

const MODELS = [
  {
    id: "claude-sonnet-4-6",
    object: "model",
    created: 1_760_000_000,
    owned_by: "actualyze",
    context_window: 1_000_000,
    max_output_tokens: 64_000,
    capabilities: { vision: true, tool_use: true, thinking: true },
    modalities: { input: ["text", "image"], output: ["text"] },
  },
];

const authorizations: string[] = [];
/** Every request the mock answered, with its path. */
const requests: { path: string; authorization: string }[] = [];
/** The Authorization header of every request addressed to the production origin. */
const productionAuthorizations: string[] = [];
let server: http.Server;
let mockURL: string;

function startMock(): Promise<void> {
  server = http.createServer((request, response) => {
    authorizations.push(String(request.headers.authorization ?? ""));
    requests.push({
      path: request.url ?? "",
      authorization: String(request.headers.authorization ?? ""),
    });
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    // Like the real endpoint, a request without a key lists nothing, so a
    // discovered model proves which key was sent.
    if (!request.headers.authorization)
      return send(401, { error: { message: "missing key" } });
    const url = request.url ?? "";
    if (url === "/openai/v1/models")
      return send(200, { object: "list", data: MODELS });
    const detail = MODELS.find(
      (model) =>
        url === `/openai/v1/models/${encodeURIComponent(model.id)}` ||
        url === `/openai/v1/models/${model.id}`,
    );
    if (detail) return send(200, detail);
    send(404, { error: { message: "not found" } });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      mockURL = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

let root: string;
const savedEnv = { ...process.env };
const realFetch = globalThis.fetch;

beforeAll(async () => {
  await startMock();
  root = await mkdtemp(
    path.join(os.tmpdir(), "opencode-actualyze-provider-e2e-"),
  );
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("OPENCODE")) delete process.env[key];
  }
  delete process.env.ACTUALYZE_API_KEY;
  delete process.env.ACTUALYZE_OPENAI_BASE_URL;
  process.env.HOME = path.join(root, "home");
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  process.env.XDG_DATA_HOME = path.join(root, "data");
  process.env.XDG_CACHE_HOME = path.join(root, "cache");
  process.env.XDG_STATE_HOME = path.join(root, "state");
  process.env.OPENCODE_DISABLE_MODELS_FETCH = "1";
  process.env.OPENCODE_DISABLE_AUTOUPDATE = "1";
  // Requests to the production endpoint are served by the local mock, so no
  // scenario reaches the network.
  globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(PRODUCTION_ORIGIN)) return realFetch(input, init);
    productionAuthorizations.push(
      new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      ).get("authorization") ?? "",
    );
    const rewritten = `${mockURL}${url.slice(PRODUCTION_ORIGIN.length)}`;
    // A Request carries its own method, headers, and body.
    return realFetch(
      input instanceof Request ? new Request(rewritten, input) : rewritten,
      init,
    );
  };
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  process.env = savedEnv;
  await new Promise((resolve) => server?.close(resolve));
  if (root) await rm(root, { recursive: true, force: true });
});

async function createHost(
  name: string,
  providers: Record<string, unknown>,
  before: readonly Plugin.Plugin[] = [],
  after: readonly Plugin.Plugin[] = [],
): Promise<{ host: OpenCode.Interface; location: { directory: string } }> {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  const { OpenCode } = await import("@opencode/sdk");
  const host = await OpenCode.create({
    plugins: [...before, plugin, ...after],
    models: { fetch: false },
    fs: { filewatcher: false },
    config: {
      project: false,
      content: JSON.stringify({ providers }),
    },
  });
  return { host, location: { directory } };
}

async function eventually<T>(
  read: () => Promise<T | undefined>,
  timeoutMs = 20_000,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

/**
 * The listed (available) `actualyze` provider, once plugins have loaded.
 * With `baseURL`, waits until the provider carries it, because the host can
 * list the built-in record before configured settings are merged over it.
 * On timeout it returns the last provider seen, so a failure shows its
 * settings.
 */
async function findProvider(
  host: OpenCode.Interface,
  location: { directory: string },
  baseURL?: string,
) {
  const read = async () =>
    (await host.provider.list({ location })).data.find(
      (entry) => entry.id === "actualyze",
    );
  let last: Awaited<ReturnType<typeof read>>;
  const found = await eventually(async () => {
    last = await read();
    if (!last) return undefined;
    if (baseURL !== undefined && last.settings?.baseURL !== baseURL)
      return undefined;
    return last;
  });
  return found ?? last;
}

async function findModel(
  host: OpenCode.Interface,
  location: { directory: string },
) {
  return eventually(async () =>
    (await host.model.list({ location })).data.find(
      (entry) =>
        entry.providerID === "actualyze" && entry.id === "claude-sonnet-4-6",
    ),
  );
}

describe("Actualyze with only ACTUALYZE_API_KEY set", () => {
  let host: OpenCode.Interface | undefined;
  let location: { directory: string };

  beforeAll(async () => {
    process.env.ACTUALYZE_API_KEY = ENV_ONLY_KEY;
    ({ host, location } = await createHost("env-only", {}));
  });

  afterAll(async () => {
    await host?.close();
    delete process.env.ACTUALYZE_API_KEY;
  });

  it("lists the provider and discovers the production endpoint's models", async () => {
    expect(await findProvider(host!, location)).toMatchObject({
      name: "Actualyze",
      integrationID: INTEGRATION_ID,
      settings: { baseURL: PRODUCTION_BASE_URL, probe: "actualyze" },
    });
    expect(await findModel(host!, location)).toBeDefined();
    expect(authorizations).toContain(`Bearer ${ENV_ONLY_KEY}`);
  });
});

describe("Actualyze with only settings.apiKey configured", () => {
  let host: OpenCode.Interface | undefined;
  let location: { directory: string };

  beforeAll(async () => {
    ({ host, location } = await createHost("settings-only", {
      actualyze: { settings: { apiKey: SETTINGS_KEY } },
    }));
  });

  afterAll(async () => {
    await host?.close();
  });

  it("keeps the production base URL and the Actualyze probe", async () => {
    const provider = await findProvider(host!, location);
    expect(provider).toMatchObject({
      name: "Actualyze",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: PRODUCTION_BASE_URL, probe: "actualyze" },
    });
  });
});

describe("Actualyze with ACTUALYZE_API_KEY and a configured base URL", () => {
  let host: OpenCode.Interface | undefined;
  let location: { directory: string };

  beforeAll(async () => {
    process.env.ACTUALYZE_API_KEY = ENV_KEY;
    ({ host, location } = await createHost("env-key", {
      actualyze: { settings: { baseURL: `${mockURL}/openai/v1` } },
    }));
  });

  afterAll(async () => {
    await host?.close();
    delete process.env.ACTUALYZE_API_KEY;
  });

  it("uses the configured base URL over the built-in one", async () => {
    const provider = await findProvider(
      host!,
      location,
      `${mockURL}/openai/v1`,
    );
    expect(provider).toMatchObject({
      integrationID: INTEGRATION_ID,
      settings: { baseURL: `${mockURL}/openai/v1`, probe: "actualyze" },
    });
  });

  it("discovers the served models with the environment key", async () => {
    expect(await findModel(host!, location)).toMatchObject({
      limit: { context: 1_000_000, output: 64_000 },
      capabilities: { tools: true, input: ["text", "image"] },
      variants: [],
    });
    expect(authorizations).toContain(`Bearer ${ENV_KEY}`);
  });
});

describe("Actualyze with ACTUALYZE_API_KEY and settings.apiKey", () => {
  let host: OpenCode.Interface | undefined;
  let location: { directory: string };

  beforeAll(async () => {
    process.env.ACTUALYZE_API_KEY = CONNECTED_KEY;
    ({ host, location } = await createHost("connected-and-settings", {
      actualyze: { settings: { apiKey: SHADOWED_SETTINGS_KEY } },
    }));
  });

  afterAll(async () => {
    await host?.close();
    delete process.env.ACTUALYZE_API_KEY;
  });

  it("discovers with the connected key, as inference does", async () => {
    expect(await findModel(host!, location)).toBeDefined();
    expect(authorizations).toContain(`Bearer ${CONNECTED_KEY}`);
    expect(authorizations).not.toContain(`Bearer ${SHADOWED_SETTINGS_KEY}`);
  });
});

/**
 * A plugin listed after scout that takes a while to set up. The host loads
 * plugins one at a time and its config provider plugin after every external
 * one, so until this setup returns, the provider list holds scout's
 * built-in record without the configured settings merged over it.
 */
const slowPlugin = {
  id: "slow-later-plugin",
  async setup() {
    await new Promise((resolve) => setTimeout(resolve, SLOW_SETUP_MS));
  },
} satisfies Plugin.Plugin;

describe("Actualyze with a configured base URL while a later plugin loads", () => {
  let host: OpenCode.Interface | undefined;
  let location: { directory: string };

  beforeAll(async () => {
    process.env.ACTUALYZE_API_KEY = SLOW_LOAD_KEY;
    ({ host, location } = await createHost(
      "slow-later-plugin",
      { actualyze: { settings: { baseURL: `${mockURL}/openai/v1` } } },
      [],
      [slowPlugin],
    ));
  });

  afterAll(async () => {
    await host?.close();
    delete process.env.ACTUALYZE_API_KEY;
  });

  it("sends the key only to the configured base URL", async () => {
    expect(await findModel(host!, location)).toBeDefined();
    expect(authorizations).toContain(`Bearer ${SLOW_LOAD_KEY}`);
    expect(productionAuthorizations).not.toContain(`Bearer ${SLOW_LOAD_KEY}`);
  });
});

describe("Actualyze with ACTUALYZE_OPENAI_BASE_URL and ACTUALYZE_API_KEY", () => {
  let host: OpenCode.Interface | undefined;
  let location: { directory: string };

  beforeAll(async () => {
    process.env.ACTUALYZE_API_KEY = RUN_ORIGIN_KEY;
    process.env.ACTUALYZE_OPENAI_BASE_URL = `${mockURL}/openai/v1/`;
    ({ host, location } = await createHost("run-origin", {}));
  });

  afterAll(async () => {
    await host?.close();
    delete process.env.ACTUALYZE_API_KEY;
    delete process.env.ACTUALYZE_OPENAI_BASE_URL;
  });

  it("points the built-in provider at that base URL and discovers there", async () => {
    expect(await findProvider(host!, location)).toMatchObject({
      integrationID: INTEGRATION_ID,
      settings: { baseURL: `${mockURL}/openai/v1`, probe: "actualyze" },
    });
    expect(await findModel(host!, location)).toBeDefined();
    expect(authorizations).toContain(`Bearer ${RUN_ORIGIN_KEY}`);
    expect(productionAuthorizations).not.toContain(`Bearer ${RUN_ORIGIN_KEY}`);
  });
});

describe("a configured base URL over ACTUALYZE_OPENAI_BASE_URL while a later plugin loads", () => {
  let host: OpenCode.Interface | undefined;
  let location: { directory: string };

  beforeAll(async () => {
    process.env.ACTUALYZE_API_KEY = RUN_ORIGIN_OVERRIDE_KEY;
    // The mock answers 404 under this prefix, so only the configured base
    // URL can list the model.
    process.env.ACTUALYZE_OPENAI_BASE_URL = `${mockURL}/run-default/openai/v1`;
    ({ host, location } = await createHost(
      "run-origin-override",
      { actualyze: { settings: { baseURL: `${mockURL}/openai/v1` } } },
      [],
      [slowPlugin],
    ));
  });

  afterAll(async () => {
    await host?.close();
    delete process.env.ACTUALYZE_API_KEY;
    delete process.env.ACTUALYZE_OPENAI_BASE_URL;
  });

  it("discovers only at the configured base URL", async () => {
    expect(
      await findProvider(host!, location, `${mockURL}/openai/v1`),
    ).toMatchObject({ settings: { baseURL: `${mockURL}/openai/v1` } });
    expect(await findModel(host!, location)).toBeDefined();
    const sent = requests.filter(
      (entry) => entry.authorization === `Bearer ${RUN_ORIGIN_OVERRIDE_KEY}`,
    );
    expect(sent.length).toBeGreaterThan(0);
    expect(
      sent.filter((entry) => entry.path.startsWith("/run-default/")),
    ).toEqual([]);
    expect(productionAuthorizations).not.toContain(
      `Bearer ${RUN_ORIGIN_OVERRIDE_KEY}`,
    );
  });
});

/**
 * Plugins and controls for a reload of scout that a plugin listed after it
 * holds open: the reload stays between scout's setup and the config
 * provider plugin's until `release()`.
 */
function gatedReload() {
  /** Times of every `provider.updated` for the location, seen by a plugin listed before scout. */
  const providerUpdates: number[] = [];
  let observed: Plugin.Context | undefined;
  let setups = 0;
  let entered: () => void = () => {};
  let release: () => void = () => {};

  // Listed before scout, so a reload that starts at scout leaves it running.
  const observer = {
    id: "reload-observer",
    async setup(context: Plugin.Context) {
      observed = context;
      void (async () => {
        for await (const event of context.event.subscribe({}))
          if (
            event.type === "provider.updated" &&
            event.location?.directory === context.location.directory
          )
            providerUpdates.push(Date.now());
      })().catch(() => {});
    },
  } satisfies Plugin.Plugin;

  // Listed after scout. Every setup after the first waits for `release`.
  const gated = {
    id: "gated-later-plugin",
    async setup() {
      setups += 1;
      if (setups === 1) return;
      await new Promise<void>((resolve) => {
        release = resolve;
        entered();
      });
    },
  } satisfies Plugin.Plugin;

  return {
    providerUpdates,
    before: [observer],
    after: [gated],
    /**
     * Register scout again under its ID, which gives it a new revision, so
     * the host restarts it and every plugin after it; resolves once the
     * gated plugin's setup is waiting.
     */
    async reload(host: OpenCode.Interface): Promise<void> {
      const reloading = new Promise<void>((resolve) => (entered = resolve));
      await host.plugin({
        id: plugin.id,
        setup: (context) => plugin.setup(context),
      });
      await reloading;
    },
    release: () => release(),
    /** Scout's `actualyze` record, read in process, which needs no finished activation. */
    async record() {
      const payload = validateCatalogPayload(
        await observed?.rpc(ModelScoutRpc).catalog({}),
      );
      return payload?.providers.find((entry) => entry.id === "actualyze");
    },
  };
}

/** Remove every stored Actualyze credential, so later scenarios start without one. */
async function removeStoredKeys(host: OpenCode.Interface | undefined) {
  if (!host) return;
  for (const credential of await host.credential.list()) {
    if (credential.integrationID === INTEGRATION_ID)
      await host.credential.remove({ credentialID: credential.id });
  }
}

describe("a reload of scout with a key connected while a later plugin loads", () => {
  let host: OpenCode.Interface | undefined;
  let location: { directory: string };
  const gate = gatedReload();

  beforeAll(async () => {
    process.env.ACTUALYZE_API_KEY = RELOAD_ENV_KEY;
    ({ host, location } = await createHost(
      "reload-with-key-change",
      { actualyze: { settings: { baseURL: `${mockURL}/openai/v1` } } },
      gate.before,
      gate.after,
    ));
  });

  afterAll(async () => {
    gate.release();
    await removeStoredKeys(host);
    await host?.close();
    delete process.env.ACTUALYZE_API_KEY;
  });

  it("sends the new key only to the configured base URL", async () => {
    expect(await findModel(host!, location)).toBeDefined();
    expect(authorizations).toContain(`Bearer ${RELOAD_ENV_KEY}`);
    await gate.reload(host!);
    const providerUpdates = gate.providerUpdates;
    const release = gate.release;

    const connectedAt = Date.now();
    await host!.integration.connect.key({
      integrationID: INTEGRATION_ID,
      key: RELOAD_KEY,
      location,
    });
    // The host publishes `provider.updated` for the credential change while
    // the reload is still setting up plugins.
    expect(
      await eventually(
        async () =>
          providerUpdates.some((at) => at >= connectedAt) ? true : undefined,
        5_000,
      ),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(productionAuthorizations).not.toContain(`Bearer ${RELOAD_KEY}`);
    release();

    expect(
      await eventually(
        async () =>
          requests.some(
            (entry) =>
              entry.path === "/openai/v1/models" &&
              entry.authorization === `Bearer ${RELOAD_KEY}`,
          )
            ? true
            : undefined,
        45_000,
      ),
    ).toBe(true);
    expect(productionAuthorizations).not.toContain(`Bearer ${RELOAD_KEY}`);
  }, 90_000);
});

describe("a reload of scout that outlasts the plugin list rule", () => {
  let host: OpenCode.Interface | undefined;
  let location: { directory: string };
  const gate = gatedReload();

  beforeAll(async () => {
    process.env.ACTUALYZE_API_KEY = HOLD_ENV_KEY;
    ({ host, location } = await createHost(
      "reload-past-list-rule",
      { actualyze: { settings: { baseURL: `${mockURL}/openai/v1` } } },
      gate.before,
      gate.after,
    ));
  });

  afterAll(async () => {
    gate.release();
    await removeStoredKeys(host);
    await host?.close();
    delete process.env.ACTUALYZE_API_KEY;
  });

  it("sends nothing anywhere until plugin.updated, then discovers at the configured base URL", async () => {
    expect(await findModel(host!, location)).toBeDefined();
    const sent = () => ({
      mock: requests.length,
      production: productionAuthorizations.length,
    });
    await gate.reload(host!);
    const before = sent();

    // The replacing instance takes the plugin list as the end of its
    // activation only after REPLACEMENT_WAIT_MS, and is then held.
    expect(
      await eventually(
        async () => ((await gate.record())?.held === true ? true : undefined),
        REPLACEMENT_WAIT_MS + 10_000,
      ),
    ).toBe(true);
    // A key change syncs again while held.
    await host!.integration.connect.key({
      integrationID: INTEGRATION_ID,
      key: HOLD_KEY,
      location,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(sent()).toEqual(before);

    gate.release();
    expect(
      await eventually(
        async () =>
          requests.some(
            (entry) =>
              entry.path === "/openai/v1/models" &&
              entry.authorization === `Bearer ${HOLD_KEY}`,
          )
            ? true
            : undefined,
        15_000,
      ),
    ).toBe(true);
    expect(productionAuthorizations.length).toBe(before.production);
    expect((await gate.record())?.held).toBe(false);
  }, 90_000);
});

/** Every integration that `/connect` would show as Actualyze. */
async function actualyzeIntegrations(
  host: OpenCode.Interface,
  location: { directory: string },
) {
  return (await host.integration.list({ location })).data
    .filter(
      (entry) =>
        entry.id === INTEGRATION_ID || entry.name.toLowerCase() === "actualyze",
    )
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      connections: entry.connections.length,
    }));
}

// Credentials persist in the data directory that every host in this file
// shares, so scenarios that need `actualyze` without a stored key run before
// the ones that store a key, and a scenario that stores a key before another
// one removes it again.
describe("an actualyze provider defined by an earlier plugin without an integration", () => {
  let host: OpenCode.Interface | undefined;
  let location: { directory: string };

  // Defines `actualyze` with `activation: "auto"` and no `integrationID`,
  // which the host gates on the integration with the ID `actualyze`.
  const earlier = {
    id: "earlier-actualyze-provider",
    async setup(context: Plugin.Context) {
      const builtIn = actualyzeProviderInfo();
      await context.provider.transform((editor) => {
        editor.add({
          info: {
            id: builtIn.id,
            name: "Actualyze (earlier plugin)",
            activation: "auto",
            package: builtIn.package,
            settings: { baseURL: `${mockURL}/openai/v1` },
          },
          models: [],
        });
      });
    },
  } satisfies Plugin.Plugin;

  beforeAll(async () => {
    ({ host, location } = await createHost("earlier-plugin", {}, [earlier]));
  });

  afterAll(async () => {
    await host?.close();
  });

  it("is hidden while the actualyze integration has no connection", async () => {
    // The integration exists once scout has loaded.
    expect(
      await eventually(async () => {
        const listed = await actualyzeIntegrations(host!, location);
        return listed.length > 0 ? listed : undefined;
      }),
    ).toEqual([{ id: INTEGRATION_ID, name: "Actualyze", connections: 0 }]);
    const providers = (await host!.provider.list({ location })).data;
    expect(providers.some((entry) => entry.id === "actualyze")).toBe(false);
  });
});

describe("Actualyze with no config and a key stored through the host", () => {
  let host: OpenCode.Interface | undefined;
  let location: { directory: string };

  beforeAll(async () => {
    ({ host, location } = await createHost("zero-config", {}));
  });

  afterAll(async () => {
    // Later scenarios start without a stored Actualyze key.
    if (host) {
      for (const credential of await host.credential.list()) {
        if (credential.integrationID === INTEGRATION_ID)
          await host.credential.remove({ credentialID: credential.id });
      }
    }
    await host?.close();
  });

  it("appears with the production endpoint and its models once a key is connected", async () => {
    expect(
      await eventually(async () => {
        const listed = await actualyzeIntegrations(host!, location);
        return listed.length > 0 ? listed : undefined;
      }),
    ).toEqual([{ id: INTEGRATION_ID, name: "Actualyze", connections: 0 }]);
    const before = (await host!.provider.list({ location })).data;
    expect(before.some((entry) => entry.id === "actualyze")).toBe(false);

    await host!.integration.connect.key({
      integrationID: INTEGRATION_ID,
      key: ZERO_CONFIG_KEY,
      location,
    });

    expect(await findProvider(host!, location)).toMatchObject({
      name: "Actualyze",
      integrationID: INTEGRATION_ID,
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: PRODUCTION_BASE_URL, probe: "actualyze" },
    });
    expect(await findModel(host!, location)).toMatchObject({
      limit: { context: 1_000_000, output: 64_000 },
      capabilities: { tools: true, input: ["text", "image"] },
    });
    expect(authorizations).toContain(`Bearer ${ZERO_CONFIG_KEY}`);
  });
});

describe("Actualyze with a configured base URL and a key stored through the host", () => {
  let host: OpenCode.Interface | undefined;
  let location: { directory: string };

  beforeAll(async () => {
    ({ host, location } = await createHost("stored-key", {
      actualyze: { settings: { baseURL: `${mockURL}/openai/v1` } },
    }));
  });

  afterAll(async () => {
    await host?.close();
  });

  it("stores the key on the provider's integration and discovers with it", async () => {
    // The config entry lists the provider before any key exists.
    expect(
      await findProvider(host!, location, `${mockURL}/openai/v1`),
    ).toMatchObject({
      integrationID: INTEGRATION_ID,
      settings: { baseURL: `${mockURL}/openai/v1`, probe: "actualyze" },
    });
    await host!.integration.connect.key({
      integrationID: INTEGRATION_ID,
      key: STORED_KEY,
      location,
    });

    expect(await actualyzeIntegrations(host!, location)).toEqual([
      { id: INTEGRATION_ID, name: "Actualyze", connections: 1 },
    ]);
    expect(await findModel(host!, location)).toMatchObject({
      limit: { context: 1_000_000, output: 64_000 },
    });
    expect(authorizations).toContain(`Bearer ${STORED_KEY}`);
  });
});
