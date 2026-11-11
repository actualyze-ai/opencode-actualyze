/**
 * Startup discovery (#20): the models of an Actualyze provider entry that
 * the plugin can read from OpenCode's own configuration sources are in the
 * catalog before the first session of a start resolves its model, so a
 * one-shot `opencode run -m <id>/<model>` and `opencode models` work as the
 * first command of a start.
 *
 * OpenCode resolves a session's model at once from the catalog as it stands
 * and gives a plugin no hook before that, while the refresher starts no
 * discovery before the host's activation has ended (see `refresher.ts`).
 * So `setup` does two things here, both bounded and both without the host:
 * it serves a stored inventory for such an entry at once, and, when there
 * is none, discovers the entry with its own base URL and its own key. The
 * key never goes anywhere but the base URL the entry names, which keeps
 * the rule the activation gate exists for.
 *
 * Only an entry that names the Actualyze probe, an http(s) `baseURL` and
 * an `apiKey` the plugin can resolve is read. The built-in `actualyze`
 * provider (a connected integration key, no config entry) is not: its key
 * is known only to the host, so its first start keeps the refresher's path.
 */
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPlainRecord } from "./catalog-evidence";
import { ACTUALYZE_PROBE_ID } from "./constants";
import {
  discoverProvider,
  normalizeBaseURL,
  type DiscoveryResult,
  type DiscoveryTarget,
} from "./discover";
import { targetKeys, type Binding, type DiscoveryStore } from "./store";
import type { TransformState } from "./transform";

export const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
export const MAX_STARTUP_TIMEOUT_MS = 60_000;

/** One provider entry read from the configuration, with its key resolved. */
export interface ConfiguredEntry {
  readonly providerID: string;
  readonly baseURL: string;
  readonly apiKey: string;
  readonly probe: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ConfigSources {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The project directory (`location.directory`). */
  readonly cwd: string;
  /** The user's home directory, for the global configuration. */
  readonly home?: string;
}

const FILE_NAMES = ["opencode.json", "opencode.jsonc"] as const;

/**
 * Strip `//` and `/* *\/` comments outside strings, so a `.jsonc` file
 * parses with `JSON.parse`. Trailing commas are left to the parser.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < text.length) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

interface ConfigDocument {
  readonly providers: Record<string, unknown>;
  /** Directory `{file:}` substitutions resolve against. */
  readonly directory: string;
}

function parseDocument(
  text: string,
  directory: string,
): ConfigDocument | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(text));
  } catch {
    return undefined;
  }
  if (!isPlainRecord(parsed) || !isPlainRecord(parsed.providers))
    return undefined;
  return { providers: parsed.providers, directory };
}

function readDocument(file: string): ConfigDocument | undefined {
  let text: string;
  try {
    if (!existsSync(file)) return undefined;
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  return parseDocument(text, path.dirname(file));
}

/**
 * The configuration documents, in the order OpenCode merges them (a later
 * one overrides an earlier one): the global directory, the project's
 * `.opencode` directory, the project directory, the file `OPENCODE_CONFIG`
 * names, then `OPENCODE_CONFIG_CONTENT`. Parent directories of the
 * project, managed preferences and remote documents are not read; an entry
 * that lives only there gets no startup discovery.
 */
export function configDocuments(sources: ConfigSources): ConfigDocument[] {
  const { env, cwd } = sources;
  const home = sources.home ?? os.homedir();
  const configHome =
    env["XDG_CONFIG_HOME"] && env["XDG_CONFIG_HOME"].length > 0
      ? env["XDG_CONFIG_HOME"]
      : path.join(home, ".config");
  const directories = [
    path.join(configHome, "opencode"),
    path.join(cwd, ".opencode"),
    cwd,
  ];
  const documents: ConfigDocument[] = [];
  for (const directory of directories)
    for (const name of FILE_NAMES) {
      const document = readDocument(path.join(directory, name));
      if (document) documents.push(document);
    }
  const explicit = env["OPENCODE_CONFIG"];
  if (explicit && explicit.length > 0) {
    const document = readDocument(path.resolve(explicit));
    if (document) documents.push(document);
  }
  const content = env["OPENCODE_CONFIG_CONTENT"];
  if (content && content.length > 0) {
    const document = parseDocument(content, cwd);
    if (document) documents.push(document);
  }
  return documents;
}

const SUBSTITUTION = /^\{(env|file):(.+)\}$/;

/**
 * A setting value as OpenCode would read it: a literal, `{env:NAME}` from
 * the environment, or `{file:path}` read relative to the document's
 * directory. Anything else the plugin cannot resolve is undefined.
 */
function resolveValue(
  value: unknown,
  document: ConfigDocument,
  env: ConfigSources["env"],
): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const match = SUBSTITUTION.exec(value);
  if (!match) return value.includes("{") ? undefined : value;
  const [, kind, argument] = match;
  if (kind === "env") {
    const resolved = env[argument ?? ""];
    return resolved && resolved.length > 0 ? resolved : undefined;
  }
  const target = (argument ?? "").replace(/^~(?=\/|$)/, os.homedir());
  try {
    const text = readFileSync(
      path.resolve(document.directory, target),
      "utf8",
    ).trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

function isHttpURL(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The entries startup discovery may read: `settings.probe` is the Actualyze
 * probe, `settings.baseURL` is an http(s) URL, and `settings.apiKey`
 * resolves. Settings of the same provider in a later document override
 * those of an earlier one key by key, as OpenCode merges them.
 */
export function readConfiguredEntries(
  sources: ConfigSources,
): ConfiguredEntry[] {
  const merged = new Map<
    string,
    {
      settings: Record<string, unknown>;
      headers: unknown;
      document: ConfigDocument;
    }
  >();
  for (const document of configDocuments(sources)) {
    for (const [providerID, entry] of Object.entries(document.providers)) {
      if (!isPlainRecord(entry)) continue;
      const previous = merged.get(providerID);
      const settings = isPlainRecord(entry.settings) ? entry.settings : {};
      merged.set(providerID, {
        settings: { ...(previous?.settings ?? {}), ...settings },
        headers: entry.headers ?? previous?.headers,
        // The document the key was read from, for a `{file:}` path.
        document:
          typeof settings.apiKey === "string"
            ? document
            : (previous?.document ?? document),
      });
    }
  }
  const entries: ConfiguredEntry[] = [];
  for (const [providerID, { settings, headers, document }] of merged) {
    if (settings.probe !== ACTUALYZE_PROBE_ID) continue;
    const baseURL = resolveValue(settings.baseURL, document, sources.env);
    if (!baseURL || !isHttpURL(baseURL)) continue;
    const apiKey = resolveValue(settings.apiKey, document, sources.env);
    if (!apiKey) continue;
    const stringHeaders = isPlainRecord(headers)
      ? Object.fromEntries(
          Object.entries(headers).filter(
            (pair): pair is [string, string] => typeof pair[1] === "string",
          ),
        )
      : undefined;
    entries.push({
      providerID,
      baseURL,
      apiKey,
      probe: ACTUALYZE_PROBE_ID,
      ...(stringHeaders && Object.keys(stringHeaders).length > 0
        ? { headers: stringHeaders }
        : {}),
    });
  }
  return entries;
}

export interface StartupDeps {
  readonly entries: readonly ConfiguredEntry[];
  readonly store: DiscoveryStore;
  readonly state: TransformState;
  /** 0 disables the network step; stored inventories are still served. */
  readonly timeoutMs: number;
  readonly discover?: (
    target: DiscoveryTarget,
    signal: AbortSignal,
  ) => Promise<DiscoveryResult>;
  /** Called for a binding this start discovered, to persist it. */
  readonly persist?: (binding: Binding) => Promise<void>;
}

export type StartupOutcome =
  | { readonly providerID: string; readonly source: "stored" }
  | { readonly providerID: string; readonly source: "discovered" }
  | {
      readonly providerID: string;
      readonly source: "failed";
      readonly reason: string;
    }
  | { readonly providerID: string; readonly source: "skipped" };

/**
 * Serve each configured entry before the first model transform: its stored
 * binding when the store holds one for the entry's endpoint and key, else
 * the result of one discovery against the entry's own base URL with the
 * entry's own key, bounded by `timeoutMs`. A failure or timeout changes
 * nothing; the refresher discovers later as before. The binding is served
 * as the entry's `settings.apiKey` credential; the first sync replaces it
 * when the host resolves a different credential for the provider.
 */
export async function startupDiscovery(
  deps: StartupDeps,
): Promise<StartupOutcome[]> {
  const discover = deps.discover ?? discoverProvider;
  const outcomes: StartupOutcome[] = [];
  for (const entry of deps.entries) {
    const keys = targetKeys({
      providerID: entry.providerID,
      baseURL: normalizeBaseURL(entry.baseURL),
      probe: entry.probe,
      apiKey: entry.apiKey,
      headers: entry.headers,
    });
    const stored = deps.store.served(keys.key);
    if (stored) {
      deps.state.active.set(entry.providerID, stored);
      outcomes.push({ providerID: entry.providerID, source: "stored" });
      continue;
    }
    if (deps.timeoutMs <= 0) {
      outcomes.push({ providerID: entry.providerID, source: "skipped" });
      continue;
    }
    let result: DiscoveryResult;
    try {
      result = await discover(
        {
          providerID: entry.providerID,
          baseURL: entry.baseURL,
          apiKey: entry.apiKey,
          probe: entry.probe,
          ...(entry.headers ? { headers: entry.headers } : {}),
        },
        AbortSignal.timeout(deps.timeoutMs),
      );
    } catch (error) {
      outcomes.push({
        providerID: entry.providerID,
        source: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!result.ok) {
      outcomes.push({
        providerID: entry.providerID,
        source: "failed",
        reason: result.failure,
      });
      continue;
    }
    const binding: Binding = {
      key: keys.key,
      endpointKey: keys.endpointKey,
      providerID: entry.providerID,
      credential: "settings",
      inventory: result.inventory,
    };
    deps.store.seed(binding);
    deps.state.active.set(entry.providerID, binding);
    outcomes.push({ providerID: entry.providerID, source: "discovered" });
    if (deps.persist) {
      try {
        await deps.persist(binding);
      } catch {
        // Storage is a cache; the refresher persists again later.
      }
    }
  }
  return outcomes;
}
