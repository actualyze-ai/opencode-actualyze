import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin";
import { discoverModels } from "./discover";
import { fetchModelsDevIndex } from "./models-dev";

/**
 * Hard upper bound (ms) on the entire config-hook discovery work. Overridable
 * via `OPENCODE_MODEL_SCOUT_TIMEOUT_MS` (bounded to a sane range) — primarily so
 * tests can use a short budget, but also a usable escape hatch.
 */
function configHookBudgetMs(): number {
  const raw = Number(process.env.OPENCODE_MODEL_SCOUT_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0)
    return Math.min(Math.max(raw, 10), 60000);
  return 5000;
}

/**
 * Resolve `promise`, or resolve with `fallback` after `ms` — whichever comes
 * first. The timer is always cleared. This is a *hard* bound: even if `promise`
 * never settles (e.g. a provider hangs while streaming a response body and the
 * work does not observe an abort signal), this returns so the caller is never
 * blocked. `signal.abort()` still fires so in-flight fetches that *do* observe
 * it get cancelled.
 */
async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(fallback);
    }, ms);
  });

  try {
    return await Promise.race([
      work(controller.signal).catch(() => fallback),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// eslint-disable-next-line @typescript-eslint/require-await
const plugin: Plugin = async (input: PluginInput) => {
  const { client } = input;

  if (!client || typeof client !== "object") {
    return {
      config: async () => {},
    };
  }

  const hooks: Hooks = {
    config: async (config) => {
      const configRecord = config as unknown as Record<string, unknown>;

      // The whole hook is bounded so it can NEVER block opencode startup. The
      // race resolves after the configured budget (see configHookBudgetMs)
      // regardless of what happens inside, and the abort signal cancels
      // in-flight fetches that observe it. All internal failures are swallowed
      // (no stdout/stderr) — a failed or slow provider must never break opencode.
      await withTimeout(
        async (signal) => {
          const modelsDevIndex = await fetchModelsDevIndex();
          await discoverModels(configRecord, modelsDevIndex, signal);
        },
        configHookBudgetMs(),
        undefined,
      );
    },
  };

  return hooks;
};

export default plugin;
