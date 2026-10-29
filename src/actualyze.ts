/**
 * The built-in Actualyze provider and its integration.
 *
 * The integration gives `/connect` and `opencode auth login actualyze` a key
 * method and reads `ACTUALYZE_API_KEY` from the server's environment. The
 * provider uses `activation: "auto"` with that integration, so the host
 * lists it only once the integration has a connection. Its
 * `settings.probe` makes it a discovery target without the auto rule.
 *
 * The integration and the provider share the ID `actualyze`, so a
 * `providers.actualyze` config entry and `opencode auth login actualyze`
 * reach the integration the provider reads its key from. The host folds
 * integrations and providers separately, so neither editor can see what the
 * other domain holds.
 *
 * The provider editor leaves an existing `actualyze` provider alone: a
 * models.dev catalog or an earlier plugin may already define it. The
 * integration editor skips registration when an `actualyze` integration
 * exists, which a catalog registers together with its `actualyze` provider,
 * so `/connect` does not offer two Actualyze entries. The config provider
 * plugin runs after external plugins and merges config settings key by key
 * over the built-in record, so an explicit `settings.baseURL` wins over the
 * base URL the record starts from: `ACTUALYZE_OPENAI_BASE_URL` when it holds
 * an http(s) URL, else the production endpoint.
 *
 * An earlier plugin's `actualyze` provider with `activation: "auto"` and no
 * `integrationID` of its own is gated by the `actualyze` integration, so the
 * host hides it until that integration has a connection.
 */
import type { Plugin } from "@opencode/plugin";
import {
  ACTUALYZE_BASE_URL,
  ACTUALYZE_BASE_URL_ENV,
  ACTUALYZE_ENV,
  ACTUALYZE_INTEGRATION_ID,
  ACTUALYZE_NAME,
  ACTUALYZE_PACKAGE,
  ACTUALYZE_PROBE_ID,
  ACTUALYZE_PROVIDER_ID,
} from "./constants";
import type { ProviderEditor } from "./transform";

type IntegrationTransform = Plugin.Context["integration"]["transform"];
export type IntegrationEditor = Parameters<
  Parameters<IntegrationTransform>[0]
>[0];
type ProviderInfo = Parameters<ProviderEditor["add"]>[0]["info"];
type IntegrationID = Parameters<IntegrationEditor["get"]>[0];

/**
 * Register the `actualyze` integration, unless a catalog or an earlier
 * plugin already registered one.
 */
export function registerActualyzeIntegration(editor: IntegrationEditor): void {
  try {
    // Integration IDs are branded strings in the host schema.
    const integrationID = ACTUALYZE_INTEGRATION_ID as IntegrationID;
    if (editor.get(integrationID)) return;
    editor.update(integrationID, (integration) => {
      integration.name = ACTUALYZE_NAME;
    });
    editor.method.update({
      integrationID,
      method: { type: "key" },
    });
    editor.method.update({
      integrationID,
      method: { type: "env", names: [ACTUALYZE_ENV] },
    });
  } catch {
    // A throwing transform disables the whole plugin; without the
    // integration the provider stays hidden, which is the safe outcome.
  }
}

/**
 * A base URL without trailing slashes, fragment, or credentials, with the
 * origin as `URL` serializes it (lowercase scheme and host, no default
 * port); undefined when it is not an http(s) URL.
 */
export function normalizeEndpointURL(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}${url.search}`;
}

/**
 * The base URL the built-in provider starts from: `ACTUALYZE_OPENAI_BASE_URL`,
 * normalized, when it holds an http(s) URL, else the production endpoint.
 */
export function actualyzeBaseURL(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const value = env[ACTUALYZE_BASE_URL_ENV];
  return (
    (value === undefined ? undefined : normalizeEndpointURL(value)) ??
    ACTUALYZE_BASE_URL
  );
}

export function actualyzeProviderInfo(
  baseURL: string = ACTUALYZE_BASE_URL,
): ProviderInfo {
  // Provider and integration IDs are branded strings in the host schema.
  return {
    id: ACTUALYZE_PROVIDER_ID as ProviderInfo["id"],
    integrationID: ACTUALYZE_INTEGRATION_ID as NonNullable<
      ProviderInfo["integrationID"]
    >,
    name: ACTUALYZE_NAME,
    activation: "auto",
    package: ACTUALYZE_PACKAGE,
    settings: { baseURL, probe: ACTUALYZE_PROBE_ID },
  };
}

/**
 * What {@link addActualyzeProvider} did: added the provider, found one that
 * another source defined, or failed and left the catalog unchanged.
 */
export type ActualyzeAddition = "added" | "existing" | "failed";

/**
 * Add the `actualyze` provider at `baseURL`, with no models, unless one
 * already exists.
 */
export function addActualyzeProvider(
  editor: ProviderEditor,
  baseURL: string = ACTUALYZE_BASE_URL,
): ActualyzeAddition {
  try {
    if (editor.get(ACTUALYZE_PROVIDER_ID)) return "existing";
    editor.add({ info: actualyzeProviderInfo(baseURL), models: [] });
    return "added";
  } catch {
    // Leave the catalog as it was rather than disable the plugin.
    return "failed";
  }
}
