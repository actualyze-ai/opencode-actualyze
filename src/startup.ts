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
 *
 * The sources, their order and the substitutions mirror OpenCode 2.2.5
 * (`packages/core/src/config.ts` `load`, `config/variable.ts`): the global
 * directory, the file `OPENCODE_CONFIG` names, the project's
 * `opencode.json(c)`, the project's `.opencode/opencode.json(c)`, then
 * `OPENCODE_CONFIG_CONTENT`, a later one overriding an earlier one;
 * `{env:NAME}` and `{file:path}` are replaced in the raw text of each
 * document before it is parsed, a file path relative to that document's
 * directory, a missing value as the empty string; comments and trailing
 * commas are accepted. Parent directories of the project, managed
 * preferences and remote documents are not read.
 */
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPlainRecord } from "./catalog-evidence";
import { ACTUALYZE_ENV, ACTUALYZE_PROBE_ID } from "./constants";
import {
  discoverProvider,
  normalizeBaseURL,
  type DiscoveryResult,
  type DiscoveryTarget,
} from "./discover";
import {
  credentialKeys,
  fingerprint,
  targetKeys,
  type Binding,
  type DiscoveryStore,
} from "./store";
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
 * Make JSONC text parseable by `JSON.parse`: drop `//` and `/* *\/`
 * comments and trailing commas outside strings, as OpenCode's parser
 * (`jsonc-parser` with `allowTrailingComma`) accepts them.
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
    if (ch === ",") {
      // A comma followed only by whitespace or comments and then a closing
      // bracket is a trailing comma.
      let j = i + 1;
      for (;;) {
        while (j < text.length && /\s/.test(text[j] ?? "")) j += 1;
        if (text[j] === "/" && text[j + 1] === "/") {
          while (j < text.length && text[j] !== "\n") j += 1;
          continue;
        }
        if (text[j] === "/" && text[j + 1] === "*") {
          const end = text.indexOf("*/", j + 2);
          j = end === -1 ? text.length : end + 2;
          continue;
        }
        break;
      }
      if (text[j] === "}" || text[j] === "]") {
        i += 1;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * `{env:NAME}` and `{file:path}` replaced in the raw text, as OpenCode does
 * before parsing: a missing variable or an unreadable file becomes the
 * empty string; a file path is relative to `directory` (or `~/`); a token
 * on a `//` comment line is left alone. The first pass inserts raw values;
 * when the result does not parse, the second pass JSON-escapes them.
 */
export function substitute(
  text: string,
  directory: string,
  env: ConfigSources["env"],
): string {
  const withEnv = (escape: boolean): string =>
    text.replace(/\{env:([^}]+)\}/g, (_match, name: string) => {
      const value = env[name] ?? "";
      return escape ? JSON.stringify(value).slice(1, -1) : value;
    });
  const withFiles = (input: string): string => {
    let out = "";
    let cursor = 0;
    for (const match of input.matchAll(/\{file:[^}]+\}/g)) {
      const token = match[0];
      const index = match.index;
      out += input.slice(cursor, index);
      const lineStart = input.lastIndexOf("\n", index - 1) + 1;
      if (input.slice(lineStart, index).trimStart().startsWith("//")) {
        out += token;
        cursor = index + token.length;
        continue;
      }
      const filePath = token.slice("{file:".length, -1);
      const expanded = filePath.startsWith("~/")
        ? path.join(os.homedir(), filePath.slice(2))
        : filePath;
      const resolved = path.isAbsolute(expanded)
        ? expanded
        : path.resolve(directory, expanded);
      let content = "";
      try {
        content = readFileSync(resolved, "utf8").trim();
      } catch {
        content = "";
      }
      out += JSON.stringify(content).slice(1, -1);
      cursor = index + token.length;
    }
    return out + input.slice(cursor);
  };
  const raw = withFiles(withEnv(false));
  if (!text.includes("{env:")) return raw;
  try {
    JSON.parse(stripJsonComments(raw));
    return raw;
  } catch {
    return withFiles(withEnv(true));
  }
}

interface ConfigDocument {
  readonly providers: Record<string, unknown>;
}

function parseDocument(
  text: string,
  directory: string,
  env: ConfigSources["env"],
): ConfigDocument | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(substitute(text, directory, env)));
  } catch {
    return undefined;
  }
  if (!isPlainRecord(parsed) || !isPlainRecord(parsed.providers))
    return undefined;
  return { providers: parsed.providers };
}

function readDocument(
  file: string,
  env: ConfigSources["env"],
): ConfigDocument | undefined {
  let text: string;
  try {
    if (!existsSync(file)) return undefined;
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  return parseDocument(text, path.dirname(file), env);
}

/**
 * The configuration documents, substituted and parsed, in the order
 * OpenCode merges them (a later one overrides an earlier one): the global
 * directory, the file `OPENCODE_CONFIG` names, the project's
 * `opencode.json(c)`, the project's `.opencode/opencode.json(c)`, then
 * `OPENCODE_CONFIG_CONTENT`.
 */
export function configDocuments(sources: ConfigSources): ConfigDocument[] {
  const { env, cwd } = sources;
  const home = sources.home ?? os.homedir();
  const configHome =
    env["XDG_CONFIG_HOME"] && env["XDG_CONFIG_HOME"].length > 0
      ? env["XDG_CONFIG_HOME"]
      : path.join(home, ".config");
  const documents: ConfigDocument[] = [];
  const readDirectory = (directory: string): void => {
    for (const name of FILE_NAMES) {
      const document = readDocument(path.join(directory, name), env);
      if (document) documents.push(document);
    }
  };
  readDirectory(path.join(configHome, "opencode"));
  const explicit = env["OPENCODE_CONFIG"];
  if (explicit && explicit.length > 0) {
    const document = readDocument(path.resolve(explicit), env);
    if (document) documents.push(document);
  }
  readDirectory(cwd);
  readDirectory(path.join(cwd, ".opencode"));
  const content = env["OPENCODE_CONFIG_CONTENT"];
  if (content && content.length > 0) {
    const document = parseDocument(content, cwd, env);
    if (document) documents.push(document);
  }
  return documents;
}

function isHttpURL(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The entries startup discovery may read: `settings.probe` is the Actualyze
 * probe, `settings.baseURL` is an http(s) URL, and `settings.apiKey` is
 * present. Settings of the same provider in a later document override
 * those of an earlier one key by key, as OpenCode merges them.
 */
export function readConfiguredEntries(
  sources: ConfigSources,
): ConfiguredEntry[] {
  const merged = new Map<
    string,
    { settings: Record<string, unknown>; headers: unknown }
  >();
  for (const document of configDocuments(sources)) {
    for (const [providerID, entry] of Object.entries(document.providers)) {
      if (!isPlainRecord(entry)) continue;
      const previous = merged.get(providerID);
      const settings = isPlainRecord(entry.settings) ? entry.settings : {};
      merged.set(providerID, {
        settings: { ...(previous?.settings ?? {}), ...settings },
        headers: entry.headers ?? previous?.headers,
      });
    }
  }
  const entries: ConfiguredEntry[] = [];
  for (const [providerID, { settings, headers }] of merged) {
    if (settings.probe !== ACTUALYZE_PROBE_ID) continue;
    const baseURL = nonEmptyString(settings.baseURL);
    if (!baseURL || !isHttpURL(baseURL)) continue;
    const apiKey = nonEmptyString(settings.apiKey);
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
  /**
   * The value of the Actualyze integration's environment variable
   * (`ACTUALYZE_API_KEY`), when set: an entry whose key is that value is
   * also seeded under the integration credential the host will resolve.
   */
  readonly integrationEnvKey?: string | undefined;
  readonly discover?: (
    target: DiscoveryTarget,
    signal: AbortSignal,
  ) => Promise<DiscoveryResult>;
  /** Called for each binding this start discovered, to persist it. */
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
 * The integration credential fingerprint the refresher computes for the
 * Actualyze integration's environment connection (`server.ts`
 * `activeCredential`: `env:<name>` and the key), so a binding seeded under
 * it is the one the first sync looks up when the host resolves that
 * connection, instead of being dropped and rediscovered with the same key.
 */
export function environmentCredential(key: string): `integration:${string}` {
  return `integration:${fingerprint(
    "integration",
    `env:${ACTUALYZE_ENV}\n${key}`,
  )}`;
}

/**
 * Serve each configured entry before the first model transform: its stored
 * binding when the store holds one for the entry's endpoint and key, else
 * the result of one discovery against the entry's own base URL with the
 * entry's own key. The entries run concurrently, each bounded by
 * `timeoutMs`, so `setup` waits at most one budget. A failure or timeout
 * changes nothing; the refresher discovers later as before. The binding is
 * served as the entry's `settings.apiKey` credential, and, when the key is
 * the integration's environment key, seeded under that credential too; the
 * first sync keeps whichever the host resolves and replaces the other.
 */
export async function startupDiscovery(
  deps: StartupDeps,
): Promise<StartupOutcome[]> {
  const discover = deps.discover ?? discoverProvider;
  const serve = async (entry: ConfiguredEntry): Promise<StartupOutcome> => {
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
      return { providerID: entry.providerID, source: "stored" };
    }
    if (deps.timeoutMs <= 0)
      return { providerID: entry.providerID, source: "skipped" };
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
      return {
        providerID: entry.providerID,
        source: "failed",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (!result.ok)
      return {
        providerID: entry.providerID,
        source: "failed",
        reason: result.failure,
      };
    const binding: Binding = {
      key: keys.key,
      endpointKey: keys.endpointKey,
      providerID: entry.providerID,
      credential: "settings",
      inventory: result.inventory,
    };
    const seeded: Binding[] = [binding];
    if (
      deps.integrationEnvKey !== undefined &&
      deps.integrationEnvKey === entry.apiKey
    ) {
      const credential = environmentCredential(entry.apiKey);
      seeded.push({
        ...binding,
        key: credentialKeys(keys, credential).key,
        credential,
      });
    }
    for (const each of seeded) deps.store.seed(each);
    deps.state.active.set(entry.providerID, binding);
    if (deps.persist) {
      for (const each of seeded) {
        try {
          await deps.persist(each);
        } catch {
          // Storage is a cache; the refresher persists again later.
        }
      }
    }
    return { providerID: entry.providerID, source: "discovered" };
  };
  return Promise.all(deps.entries.map(serve));
}
