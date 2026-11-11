/**
 * Embedded-host E2E for startup discovery (#20): a file-configured
 * Actualyze entry (`settings.probe: "actualyze"`, a base URL and a key, the
 * shape the App Setup Guide and the `aai start` launch write) is in the
 * host's model list on the very first read after the host starts, so a
 * session created at once can resolve it; on a later start the stored
 * inventory is served with no network request at all.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenCode } from "@opencode/sdk";
import plugin from "../../src/server";

const PROVIDER = "actualyze";
const KEY = "aai_pat_startup_e2e";
const MODELS = [
  {
    id: "gpt-4o",
    object: "model",
    created: 1_760_000_000,
    owned_by: "actualyze",
    context_window: 128_000,
    max_output_tokens: 16_384,
    capabilities: {
      vision: true,
      tool_use: true,
      thinking: false,
      thinking_adaptive: false,
      temperature: true,
    },
    modalities: { input: ["text", "image"], output: ["text"] },
    cost: { input: 2.5, output: 10 },
  },
  {
    id: "assistant-test-vm",
    object: "model",
    created: 1_760_000_001,
    owned_by: "actualyze",
    context_window: 128_000,
    max_output_tokens: 16_384,
    capabilities: { vision: false, tool_use: true, thinking: null },
    modalities: { input: ["text"], output: ["text"] },
  },
];

const requests: Array<{ url: string; authorization: string }> = [];
let server: http.Server;
let mockURL: string;

function startMock(): Promise<void> {
  server = http.createServer((request, response) => {
    requests.push({
      url: request.url ?? "",
      authorization: String(request.headers.authorization ?? ""),
    });
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const url = request.url ?? "";
    if (url === "/openai/v1/models")
      return send(200, { object: "list", data: MODELS });
    const detail = MODELS.find(
      (model) => url === `/openai/v1/models/${model.id}`,
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
let project: string;
const savedEnv = { ...process.env };

function configContent(): string {
  return JSON.stringify({
    providers: {
      [PROVIDER]: {
        name: "Actualyze",
        package: "aisdk:@ai-sdk/openai-compatible",
        settings: {
          baseURL: `${mockURL}/openai/v1`,
          apiKey: KEY,
          probe: "actualyze",
        },
        models: {
          "declared-vm": {
            name: "Declared By Hand",
            limit: { context: 4_096, output: 256 },
          },
        },
      },
    },
  });
}

async function createHost(): Promise<OpenCode.Interface> {
  const { OpenCode } = await import("@opencode/sdk");
  const content = configContent();
  // The plugin reads the same content the host loads, as OpenCode's own
  // server process sets it from the launcher's environment.
  process.env.OPENCODE_CONFIG_CONTENT = content;
  return OpenCode.create({
    plugins: [plugin],
    models: { fetch: false },
    fs: { filewatcher: false },
    config: { project: false, content },
  });
}

beforeAll(async () => {
  await startMock();
  root = await mkdtemp(
    path.join(os.tmpdir(), "opencode-actualyze-startup-e2e-"),
  );
  project = path.join(root, "project");
  await mkdir(project, { recursive: true });
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("OPENCODE")) delete process.env[key];
  }
  delete process.env.ACTUALYZE_API_KEY;
  process.env.HOME = path.join(root, "home");
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  process.env.XDG_DATA_HOME = path.join(root, "data");
  process.env.XDG_CACHE_HOME = path.join(root, "cache");
  process.env.XDG_STATE_HOME = path.join(root, "state");
  process.env.OPENCODE_DISABLE_MODELS_FETCH = "1";
  process.env.OPENCODE_DISABLE_AUTOUPDATE = "1";
});

afterAll(async () => {
  process.env = savedEnv;
  await new Promise((resolve) => server?.close(resolve));
  if (root) await rm(root, { recursive: true, force: true });
});

const location = () => ({ directory: project });

/**
 * The location is initialized once the configured provider is listed: the
 * config provider plugin runs after every external plugin, so by then the
 * plugin's `setup` has finished. The model list is then read exactly once,
 * with no further waiting, which is what a session created at that moment
 * resolves against.
 */
async function modelsOnceReady(host: OpenCode.Interface) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const providers = (await host.provider.list({ location: location() })).data;
    if (providers.some((provider) => provider.id === PROVIDER)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return (await host.model.list({ location: location() })).data;
}

describe("startup discovery in an embedded host", () => {
  it("lists the entry's models on the first read after the host starts, from one request with the entry's key", async () => {
    const host = await createHost();
    try {
      const models = await modelsOnceReady(host);
      const gpt = models.find(
        (model) => model.providerID === PROVIDER && model.id === "gpt-4o",
      );
      expect(gpt).toMatchObject({
        name: "GPT 4O",
        limit: { context: 128_000, output: 16_384 },
        capabilities: { tools: true },
      });
      expect(
        models.some(
          (model) =>
            model.providerID === PROVIDER && model.id === "assistant-test-vm",
        ),
      ).toBe(true);
      expect(
        models.find(
          (model) =>
            model.providerID === PROVIDER && model.id === "declared-vm",
        ),
      ).toMatchObject({
        name: "Declared By Hand",
        limit: { context: 4_096, output: 256 },
      });
      const lists = requests.filter((r) => r.url === "/openai/v1/models");
      expect(lists.length).toBeGreaterThanOrEqual(1);
      for (const request of requests)
        expect(request.authorization).toBe(`Bearer ${KEY}`);
    } finally {
      await host.close();
    }
  });

  it("serves the stored inventory on a later start with no network request", async () => {
    const before = requests.length;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("network is off for this start");
    };
    try {
      const host = await createHost();
      try {
        const models = await modelsOnceReady(host);
        expect(
          models.some(
            (model) => model.providerID === PROVIDER && model.id === "gpt-4o",
          ),
        ).toBe(true);
      } finally {
        await host.close();
      }
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(requests.length).toBe(before);
  });
});
