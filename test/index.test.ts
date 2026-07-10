import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import plugin from "../src/index";

/** A minimal PluginInput with a truthy `client` so the plugin registers hooks. */
const input = { client: {} } as unknown as Parameters<typeof plugin>[0];

/** A config with one discoverable provider (would trigger a network fetch). */
function configWithProvider() {
  return {
    provider: {
      hang: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://localhost:9/v1", apiKey: "k" },
      },
    },
  } as unknown as Record<string, unknown>;
}

describe("config hook — hard timeout", () => {
  beforeEach(() => {
    process.env.OPENCODE_MODEL_SCOUT_TIMEOUT_MS = "80";
    mockFetch.mockReset();
  });
  afterEach(() => {
    delete process.env.OPENCODE_MODEL_SCOUT_TIMEOUT_MS;
    vi.restoreAllMocks();
  });

  it("returns even if every provider fetch hangs forever", async () => {
    // fetch never resolves — the only thing that can unblock is the budget.
    mockFetch.mockImplementation(() => new Promise(() => {}));

    const hooks = await plugin(input);
    const config = configWithProvider();

    const start = Date.now();
    await expect(
      (hooks.config as (c: Record<string, unknown>) => Promise<void>)(config),
    ).resolves.toBeUndefined();
    const elapsed = Date.now() - start;

    // Should return around the 80ms budget, well under any real hang.
    expect(elapsed).toBeLessThan(2000);
  });

  it("returns within the hook budget even if a resolved fetch stalls its body forever", async () => {
    // Headers arrive; body read (text/json) never resolves. The outer hook
    // budget (80ms here) is what unblocks the hook. The independent body-read
    // bound (readJson/raceBody) is proven separately in util.test.ts.
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => new Promise(() => {}),
      text: () => new Promise(() => {}),
      body: { cancel: () => Promise.resolve() },
    });

    const hooks = await plugin(input);
    const start = Date.now();
    await expect(
      (hooks.config as (c: Record<string, unknown>) => Promise<void>)(
        configWithProvider(),
      ),
    ).resolves.toBeUndefined();
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("never writes to stdout/stderr during the config hook", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    mockFetch.mockImplementation(() => Promise.reject(new Error("boom")));

    const hooks = await plugin(input);
    await (hooks.config as (c: Record<string, unknown>) => Promise<void>)(
      configWithProvider(),
    );

    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("degrades to a no-op config hook when no client is provided", async () => {
    const hooks = await plugin({} as unknown as Parameters<typeof plugin>[0]);
    await expect(
      (hooks.config as (c: Record<string, unknown>) => Promise<void>)({}),
    ).resolves.toBeUndefined();
  });
});
