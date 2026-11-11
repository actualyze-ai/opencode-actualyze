import { describe, expect, it } from "vitest";
import {
  CATALOG_SCHEMA_VERSION,
  unknownScalar,
  type CatalogModelRecord,
  type CatalogPayload,
  type CatalogProviderRecord,
  type CredentialSource,
} from "../src/catalog-evidence";
import {
  actualyzeEndpoint,
  actualyzeLinks,
  actualyzeProviderID,
  awaitingCheck,
  BUILT_IN_ENDPOINT,
  canEnterKey,
  createSessionTracker,
  defaultEndpoint,
  deriveActualyzeState,
  displayOrigin,
  failureLink,
  fitStatusParts,
  hasInventory,
  inActionOrder,
  integrationFacts,
  keyLabel,
  linkLayout,
  reducePending,
  retrySentence,
  retryTitle,
  submitEvent,
  type ActualyzeInputs,
  type ActualyzeRow,
  type PendingMarker,
} from "../src/tui-actualyze";

const AT = "2026-10-16T10:00:00.000Z";

/** Models only count here; their fields are never read. */
const MODEL = { id: "m" } as unknown as CatalogModelRecord;

function record(
  overrides: Partial<CatalogProviderRecord> = {},
): CatalogProviderRecord {
  return {
    id: "actualyze",
    endpointOrigin: unknownScalar(),
    configuredProbe: unknownScalar(),
    resolvedProbe: unknownScalar(),
    lastGoodAt: AT,
    failure: null,
    modelListAttempt: "ready",
    probeAttempt: "complete",
    skippedModelIds: [],
    models: [MODEL, MODEL],
    discovering: false,
    lastAttemptAt: AT,
    nextRefreshAt: null,
    held: false,
    credentialSource: "connection",
    credentialEpoch: 2,
    resultEpoch: 2,
    ...overrides,
  };
}

function payload(
  provider: CatalogProviderRecord | undefined,
  overrides: Partial<CatalogPayload> = {},
): CatalogPayload {
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    packageVersion: "2.0.0",
    instanceID: "i1",
    generatedAt: AT,
    status: "complete",
    completedAt: AT,
    builtIn: { actualyze: "managed" },
    providers: provider ? [provider] : [],
    ...overrides,
  };
}

function marker(
  phase: PendingMarker["phase"],
  overrides: Partial<PendingMarker> = {},
): PendingMarker {
  return {
    session: 1,
    phase,
    providerIDAtSubmit: "actualyze",
    epochAtSubmit: 1,
    instanceIDAtSubmit: "i1",
    ...overrides,
  };
}

function rowOf(inputs: Partial<ActualyzeInputs>): ActualyzeRow {
  return deriveActualyzeState({
    providerID: "actualyze",
    pending: undefined,
    server: "ready",
    payload: payload(record()),
    connected: true,
    ...inputs,
  }).row;
}

describe("the provider the dialog shows", () => {
  /** A run's provider, as Actualyze Desktop and Atlas define it. */
  const run = (id = "actualyze-start") => ({
    id,
    settings: {
      baseURL: "https://app.actualyze.ai/openai/v1",
      probe: "actualyze",
    },
  });

  it("is actualyze whenever OpenCode lists it, even beside a run's provider", () => {
    expect(actualyzeProviderID([{ id: "actualyze" }])).toBe("actualyze");
    expect(actualyzeProviderID([run(), { id: "actualyze" }])).toBe("actualyze");
    expect(actualyzeProviderID([{ id: "actualyze" }, run()])).toBe("actualyze");
  });

  it("is the only provider probed for actualyze when actualyze is not listed", () => {
    expect(actualyzeProviderID([run()])).toBe("actualyze-start");
    expect(
      actualyzeProviderID([
        { id: "openai" },
        { id: "local", settings: { probe: "vllm" } },
        { id: "odd", settings: null },
        run(),
      ]),
    ).toBe("actualyze-start");
  });

  it("falls back to actualyze when no single listed provider is probed for actualyze", () => {
    const cases: Array<Parameters<typeof actualyzeProviderID>[0]> = [
      undefined,
      [],
      [{ id: "openai" }],
      [{ id: "local", settings: { probe: "vllm" } }],
      [run("actualyze-start"), run("actualyze-atlas")],
      [{ id: "odd", settings: null }],
      [{ id: "odd", settings: "actualyze" }],
      [{ id: "odd", settings: { probe: ["actualyze"] } }],
    ];
    for (const providers of cases)
      expect(actualyzeProviderID(providers), JSON.stringify(providers)).toBe(
        "actualyze",
      );
  });
});

describe("endpoint", () => {
  it("uses the built-in origin without a badge when no base URL is set", () => {
    expect(actualyzeEndpoint(undefined)).toEqual(BUILT_IN_ENDPOINT);
    expect(actualyzeEndpoint("")).toEqual(BUILT_IN_ENDPOINT);
    expect(BUILT_IN_ENDPOINT).toEqual({
      origin: "https://app.actualyze.ai",
      customEndpoint: false,
    });
  });

  it("treats spellings of the built-in base URL as the built-in endpoint", () => {
    for (const url of [
      "https://app.actualyze.ai/openai/v1",
      "https://app.actualyze.ai/openai/v1/",
      "HTTPS://APP.ACTUALYZE.AI:443/openai/v1//",
      " https://app.actualyze.ai/openai/v1#top",
    ])
      expect(actualyzeEndpoint(url), url).toEqual({
        origin: "https://app.actualyze.ai",
        customEndpoint: false,
      });
  });

  it("flags a different path, query, scheme, or host as custom and keeps only its origin", () => {
    expect(actualyzeEndpoint("https://app.actualyze.ai/openai")).toEqual({
      origin: "https://app.actualyze.ai",
      customEndpoint: true,
    });
    expect(
      actualyzeEndpoint("https://app.actualyze.ai/openai/v1?env=dev"),
    ).toEqual({ origin: "https://app.actualyze.ai", customEndpoint: true });
    expect(actualyzeEndpoint("http://app.actualyze.ai/openai/v1")).toEqual({
      origin: "http://app.actualyze.ai",
      customEndpoint: true,
    });
    expect(
      actualyzeEndpoint("https://user:secret@actualyze.dev.example/openai/v1"),
    ).toEqual({
      origin: "https://actualyze.dev.example",
      customEndpoint: true,
    });
  });

  it("gives an unusable base URL no origin, so no link falls back to production", () => {
    for (const value of ["not a url", "ftp://app.actualyze.ai/openai/v1", 42])
      expect(actualyzeEndpoint(value)).toEqual({
        origin: undefined,
        customEndpoint: true,
      });
  });

  describe("while the provider is hidden", () => {
    it("is the production endpoint without ACTUALYZE_OPENAI_BASE_URL or with an unusable one", () => {
      expect(defaultEndpoint({})).toEqual(BUILT_IN_ENDPOINT);
      expect(
        defaultEndpoint({ ACTUALYZE_OPENAI_BASE_URL: "not a url" }),
      ).toEqual(BUILT_IN_ENDPOINT);
    });

    it("is the run's origin, flagged custom, when ACTUALYZE_OPENAI_BASE_URL names another endpoint", () => {
      expect(
        defaultEndpoint({
          ACTUALYZE_OPENAI_BASE_URL: "https://staging.example/openai/v1",
        }),
      ).toEqual({ origin: "https://staging.example", customEndpoint: true });
    });

    it("is not custom when ACTUALYZE_OPENAI_BASE_URL spells the production endpoint", () => {
      expect(
        defaultEndpoint({
          ACTUALYZE_OPENAI_BASE_URL: "https://app.actualyze.ai/openai/v1/",
        }),
      ).toEqual(BUILT_IN_ENDPOINT);
    });
  });

  it("shows the host for https and the full origin otherwise", () => {
    expect(displayOrigin("https://app.actualyze.ai")).toBe("app.actualyze.ai");
    expect(displayOrigin("http://127.0.0.1:47932")).toBe(
      "http://127.0.0.1:47932",
    );
  });
});

describe("links", () => {
  it("puts every app page on the given origin, in screen order", () => {
    expect(
      actualyzeLinks("https://actualyze.dev.example").map((link) => [
        link.label,
        link.url,
      ]),
    ).toEqual([
      [
        "API Keys",
        "https://actualyze.dev.example/account/settings?tab=security",
      ],
      ["Catalog", "https://actualyze.dev.example/control/catalog?tab=consume"],
      ["Budgets", "https://actualyze.dev.example/management/budgets"],
      ["Usage", "https://actualyze.dev.example/observability?tab=inference"],
      [
        "Troubleshooting",
        "https://actualyze.dev.example/observability?tab=troubleshooting",
      ],
    ]);
  });

  it("points 401 and 403 at API keys, 402 at Budgets, and everything else at Troubleshooting", () => {
    expect(failureLink("unauthorized")).toBe("apiKeys");
    expect(failureLink("forbidden")).toBe("apiKeys");
    expect(failureLink("payment-required")).toBe("budgets");
    for (const kind of [
      "rate-limited",
      "not-found",
      "server-error",
      "http-error",
      "unreachable",
      "timeout",
      "aborted",
      "invalid-response",
      "error",
    ] as const)
      expect(failureLink(kind)).toBe("troubleshooting");
  });
});

describe("integration facts", () => {
  it("reads the first connection as the active one", () => {
    expect(
      integrationFacts({
        methods: [],
        connections: [
          { type: "credential", label: "Laptop" },
          { type: "env", name: "ACTUALYZE_API_KEY" },
        ],
      }).connection,
    ).toEqual({ kind: "credential", label: "Laptop" });
    expect(
      integrationFacts({
        connections: [{ type: "env", name: "ACTUALYZE_API_KEY" }],
      }).connection,
    ).toEqual({ kind: "env", name: "ACTUALYZE_API_KEY" });
    expect(integrationFacts({ connections: [] }).connection).toBeUndefined();
    expect(integrationFacts(undefined)).toEqual({
      connection: undefined,
      keyMethod: false,
    });
  });

  it("offers key entry only for a plain key method without form fields", () => {
    expect(integrationFacts({ methods: [{ type: "key" }] }).keyMethod).toBe(
      true,
    );
    expect(
      integrationFacts({ methods: [{ type: "key", form: [{ key: "org" }] }] })
        .keyMethod,
    ).toBe(false);
    expect(
      integrationFacts({ methods: [{ type: "oauth" }, { type: "env" }] })
        .keyMethod,
    ).toBe(false);
  });

  it("enables k only for the actualyze integration with a plain key method", () => {
    const plain = integrationFacts({ methods: [{ type: "key" }] });
    expect(canEnterKey("actualyze", plain)).toBe(true);
    expect(canEnterKey("team-gateway", plain)).toBe(false);
    expect(
      canEnterKey(
        "actualyze",
        integrationFacts({ methods: [{ type: "oauth" }] }),
      ),
    ).toBe(false);
    expect(canEnterKey("actualyze", undefined)).toBe(false);
  });

  it("names the key by settings.apiKey, the environment variable, or the quoted label", () => {
    const credential = { kind: "credential", label: "Laptop" } as const;
    expect(keyLabel(credential, "settings")).toBe("settings.apiKey");
    expect(keyLabel(undefined, "settings")).toBe("settings.apiKey");
    expect(keyLabel(credential, "connection")).toBe('"Laptop"');
    expect(
      keyLabel({ kind: "env", name: "ACTUALYZE_API_KEY" }, "connection"),
    ).toBe("ACTUALYZE_API_KEY");
    expect(keyLabel(undefined, "none")).toBeUndefined();
  });
});

describe("pending marker", () => {
  it("records the provider, epoch, and instance at submit, or -1 without a record", () => {
    expect(
      submitEvent(3, payload(record({ credentialEpoch: 4 })), "actualyze"),
    ).toEqual({
      type: "submit",
      session: 3,
      providerIDAtSubmit: "actualyze",
      epochAtSubmit: 4,
      instanceIDAtSubmit: "i1",
    });
    expect(submitEvent(3, payload(undefined), "actualyze").epochAtSubmit).toBe(
      -1,
    );
    expect(submitEvent(3, undefined, "actualyze")).toEqual({
      type: "submit",
      session: 3,
      providerIDAtSubmit: "actualyze",
      epochAtSubmit: -1,
      instanceIDAtSubmit: undefined,
    });
  });

  it("takes the epoch at submit from the shown provider's record only", () => {
    const both = payload(undefined, {
      providers: [
        record({ credentialEpoch: 4 }),
        record({ id: "actualyze-start", credentialEpoch: 7 }),
      ],
    });
    expect(submitEvent(3, both, "actualyze-start")).toMatchObject({
      providerIDAtSubmit: "actualyze-start",
      epochAtSubmit: 7,
    });
    expect(submitEvent(3, both, "actualyze")).toMatchObject({
      providerIDAtSubmit: "actualyze",
      epochAtSubmit: 4,
    });
    expect(submitEvent(3, payload(record()), "actualyze-start")).toEqual({
      type: "submit",
      session: 3,
      providerIDAtSubmit: "actualyze-start",
      epochAtSubmit: -1,
      instanceIDAtSubmit: "i1",
    });
  });

  it("takes the epoch at submit as the baseline only for the same server instance and provider", () => {
    const pending = marker("saved", {
      providerIDAtSubmit: "actualyze-start",
      epochAtSubmit: 5,
    });
    const run = (credentialEpoch: number, instanceID = "i1") =>
      payload(
        record({
          id: "actualyze-start",
          credentialEpoch,
          resultEpoch: credentialEpoch,
        }),
        { instanceID },
      );
    expect(awaitingCheck(pending, run(5), "actualyze-start")).toBe(true);
    expect(awaitingCheck(pending, run(6), "actualyze-start")).toBe(false);
    // Epochs restart with the server instance and differ between providers.
    expect(awaitingCheck(pending, run(0, "i2"), "actualyze-start")).toBe(false);
    const shownOnActualyze = payload(
      record({ credentialEpoch: 0, resultEpoch: 0 }),
    );
    expect(awaitingCheck(pending, shownOnActualyze, "actualyze")).toBe(false);
  });

  it("leaves checking when a key submitted on an alias provider settles on actualyze", () => {
    // The alias is probed for actualyze and uses the actualyze integration,
    // so k was allowed while the dialog showed it.
    const onAlias = payload(
      record({ id: "team-actualyze", credentialEpoch: 3, resultEpoch: 3 }),
    );
    let pending = reducePending(
      undefined,
      submitEvent(1, onAlias, "team-actualyze"),
    );
    pending = reducePending(pending, { type: "resolved", session: 1, at: 0 });
    expect(
      rowOf({ providerID: "team-actualyze", pending, payload: onAlias }),
    ).toBe("checking");
    // The connected key lists actualyze, whose record has epochs of its own.
    const onActualyze = payload(record({ credentialEpoch: 0, resultEpoch: 0 }));
    expect(
      rowOf({ providerID: "actualyze", pending, payload: onActualyze }),
    ).toBe("ready");
  });

  it("checks a saved key against the shown provider's record only", () => {
    const pending = marker("saved", { epochAtSubmit: 1 });
    const settled = record({
      id: "actualyze-start",
      credentialEpoch: 2,
      resultEpoch: 2,
    });
    const before = record({ credentialEpoch: 1, resultEpoch: 1 });
    const both = payload(undefined, { providers: [before, settled] });
    expect(awaitingCheck(pending, both, "actualyze-start")).toBe(false);
    expect(awaitingCheck(pending, both, "actualyze")).toBe(true);
    // Another provider's settled record is no record for the shown one.
    expect(awaitingCheck(pending, payload(settled), "actualyze")).toBe(true);
  });

  it("starts saving on submit and replaces an earlier marker", () => {
    const next = reducePending(marker("unconfirmed"), {
      type: "submit",
      session: 2,
      providerIDAtSubmit: "actualyze-start",
      epochAtSubmit: 5,
      instanceIDAtSubmit: "i2",
    });
    expect(next).toEqual({
      session: 2,
      phase: "saving",
      providerIDAtSubmit: "actualyze-start",
      epochAtSubmit: 5,
      instanceIDAtSubmit: "i2",
    });
  });

  it("moves its own saving marker to saved, and ignores completions for other sessions or phases", () => {
    expect(
      reducePending(marker("saving"), { type: "resolved", session: 1, at: 7 }),
    ).toEqual(marker("saved", { savedAt: 7 }));
    const other = marker("saving", { session: 2 });
    expect(reducePending(other, { type: "resolved", session: 1, at: 7 })).toBe(
      other,
    );
    const unconfirmed = marker("unconfirmed");
    expect(
      reducePending(unconfirmed, { type: "resolved", session: 1, at: 7 }),
    ).toBe(unconfirmed);
    expect(
      reducePending(undefined, { type: "resolved", session: 1, at: 7 }),
    ).toBeUndefined();
  });

  it("marks a rejected or timed-out save unconfirmed, since OpenCode may have stored the key", () => {
    expect(
      reducePending(marker("saving"), { type: "rejected", session: 1 }),
    ).toEqual(marker("unconfirmed"));
    const saved = marker("saved");
    expect(reducePending(saved, { type: "rejected", session: 1 })).toBe(saved);
  });

  it("clears a saved marker once checked, and only a saved one", () => {
    expect(reducePending(marker("saved"), { type: "checked" })).toBeUndefined();
    const saving = marker("saving");
    expect(reducePending(saving, { type: "checked" })).toBe(saving);
  });

  it("clears with the end of its own session only", () => {
    expect(
      reducePending(marker("saved"), { type: "ended", session: 1 }),
    ).toBeUndefined();
    const other = marker("saved", { session: 2 });
    expect(reducePending(other, { type: "ended", session: 1 })).toBe(other);
  });

  it("walks submit, the prompt round trip, the save, and the check to ready", () => {
    const before = payload(record({ credentialEpoch: 1, resultEpoch: 1 }));
    // Submit happens after the prompt returns; the round trip itself sends no event.
    let pending = reducePending(undefined, submitEvent(1, before, "actualyze"));
    expect(rowOf({ pending, payload: before })).toBe("saving");

    pending = reducePending(pending, { type: "resolved", session: 1, at: 0 });
    expect(rowOf({ pending, payload: before })).toBe("checking");

    // The switch to the new credential, with no result yet.
    const switched = payload(
      record({
        credentialEpoch: 2,
        resultEpoch: 1,
        lastGoodAt: null,
        models: [],
      }),
    );
    expect(rowOf({ pending, payload: switched })).toBe("checking");

    const settled = payload(record({ credentialEpoch: 2, resultEpoch: 2 }));
    expect(rowOf({ pending, payload: settled })).toBe("ready");
    pending = reducePending(pending, { type: "checked" });
    expect(pending).toBeUndefined();
    expect(rowOf({ pending, payload: settled })).toBe("ready");
  });

  it("shows a rejected or timed-out save as unconfirmed whatever the catalog says", () => {
    const pending = reducePending(marker("saving"), {
      type: "rejected",
      session: 1,
    });
    expect(rowOf({ pending })).toBe("unconfirmed");
    expect(rowOf({ pending, server: "unavailable" })).toBe("unconfirmed");
  });

  it("drops the marker when a cancelled prompt ends the session", () => {
    const pending = reducePending(marker("saved"), {
      type: "ended",
      session: 1,
    });
    expect(rowOf({ pending })).toBe("ready");
  });
});

describe("state", () => {
  it("shows a held record as held instead of waiting for a discovery that cannot come", () => {
    const waiting = {
      lastGoodAt: null,
      models: [],
      credentialEpoch: 2,
      resultEpoch: null,
    };
    for (const overrides of [
      { held: true },
      { held: true, ...waiting },
      { held: true, credentialSource: "none" as const, ...waiting },
      { held: true, failure: { kind: "timeout" as const, at: AT } },
    ])
      expect(rowOf({ payload: payload(record(overrides)) })).toBe("held");
    // A saved key would otherwise wait for a check the hold never runs.
    expect(
      rowOf({
        pending: marker("saved"),
        payload: payload(record({ held: true, ...waiting })),
      }),
    ).toBe("held");
    expect(rowOf({ payload: payload(record({ held: false })) })).toBe("ready");
  });

  it("reads the shown provider's record from a payload that has several", () => {
    const both = payload(undefined, {
      providers: [
        record({ held: true }),
        record({ id: "actualyze-start", credentialSource: "settings" }),
      ],
    });
    const state = (providerID: string) =>
      deriveActualyzeState({
        providerID,
        pending: undefined,
        server: "ready",
        payload: both,
        connected: true,
      });
    expect(state("actualyze-start").row).toBe("ready");
    expect(state("actualyze-start").record?.credentialSource).toBe("settings");
    expect(state("actualyze").row).toBe("held");
    expect(state("actualyze").record?.held).toBe(true);
  });

  it("waits for the catalog before saying no key is connected", () => {
    // A settings.apiKey user has no connection; only the record tells them apart.
    expect(
      rowOf({ server: "loading", payload: undefined, connected: false }),
    ).toBe("resolving");
    expect(rowOf({ payload: payload(undefined), connected: false })).toBe(
      "no-key",
    );
    expect(
      rowOf({
        payload: payload(record({ credentialSource: "settings" })),
        connected: false,
      }),
    ).toBe("ready");
  });

  it("counts any current record as new after the server instance changed", () => {
    const pending = marker("saved", { epochAtSubmit: 5 });
    const reloaded = payload(record({ credentialEpoch: 0, resultEpoch: 0 }), {
      instanceID: "i2",
    });
    expect(rowOf({ pending, payload: reloaded })).toBe("ready");
    const same = payload(record({ credentialEpoch: 5, resultEpoch: 5 }));
    expect(rowOf({ pending, payload: same })).toBe("checking");
  });

  it("never shows a previous credential's result on a record that is not current", () => {
    const stale = payload(
      record({
        credentialEpoch: 3,
        resultEpoch: 2,
        failure: { kind: "unauthorized", at: AT, httpStatus: 401 },
      }),
    );
    expect(rowOf({ payload: stale })).toBe("resolving");
    expect(rowOf({ payload: stale, connected: undefined })).toBe("resolving");
  });

  it("places a failure card above the inventory only when one exists", () => {
    expect(hasInventory(record())).toBe(true);
    expect(hasInventory(record({ lastGoodAt: null }))).toBe(false);
    expect(hasInventory(record({ models: [] }))).toBe(false);
    expect(hasInventory(undefined)).toBe(false);
  });
});

describe("state table", () => {
  type Pending = "none" | PendingMarker["phase"];
  type RecordShape =
    | undefined
    | {
        credentialSource: CredentialSource;
        credentialEpoch: number;
        current: boolean;
        discovering: boolean;
        lastGood: boolean;
        failure: boolean;
        models: number;
      };

  function* shapes(): Generator<RecordShape> {
    yield undefined;
    const sources: CredentialSource[] = [
      "none",
      "connection",
      "settings",
      "headers",
      "unresolved",
    ];
    for (const credentialSource of sources)
      for (const credentialEpoch of [1, 2])
        for (const current of [true, false])
          for (const discovering of [true, false])
            for (const lastGood of [true, false])
              for (const failure of [true, false])
                for (const models of [0, 2])
                  yield {
                    credentialSource,
                    credentialEpoch,
                    current,
                    discovering,
                    lastGood,
                    failure,
                    models,
                  };
  }

  /** The built-in provider and a run's provider. */
  const PROVIDER_IDS = ["actualyze", "actualyze-start"] as const;
  type ProviderID = (typeof PROVIDER_IDS)[number];

  function build(
    shape: RecordShape,
    id: ProviderID,
  ): CatalogProviderRecord | undefined {
    if (!shape) return undefined;
    return record({
      id,
      credentialSource: shape.credentialSource,
      credentialEpoch: shape.credentialEpoch,
      resultEpoch: shape.current ? shape.credentialEpoch : null,
      discovering: shape.discovering,
      lastGoodAt: shape.lastGood ? AT : null,
      failure: shape.failure
        ? { kind: "server-error", at: AT, httpStatus: 503 }
        : null,
      models: Array.from({ length: shape.models }, () => MODEL),
    });
  }

  interface Combination {
    /** The provider the dialog shows. */
    readonly providerID: ProviderID;
    /** The provider the payload's one record belongs to. */
    readonly recordID: ProviderID;
    /** The provider the dialog showed when the key was submitted. */
    readonly submittedOn: ProviderID;
    readonly pending: Pending;
    readonly server: ActualyzeInputs["server"];
    readonly builtIn: "managed" | "foreign";
    readonly status: CatalogPayload["status"];
    readonly instanceID: string;
    readonly connected: boolean | undefined;
    readonly shape: RecordShape;
  }

  function* combinations(): Generator<Combination> {
    const pendings: Pending[] = ["none", "saving", "saved", "unconfirmed"];
    const servers: ActualyzeInputs["server"][] = [
      "loading",
      "unavailable",
      "ready",
    ];
    for (const providerID of PROVIDER_IDS)
      for (const recordID of PROVIDER_IDS)
        for (const submittedOn of PROVIDER_IDS)
          for (const shape of shapes())
            for (const pending of pendings)
              for (const server of servers)
                for (const builtIn of ["managed", "foreign"] as const)
                  for (const status of ["pending", "complete"] as const)
                    for (const instanceID of ["i1", "i2"])
                      for (const connected of [undefined, false, true])
                        yield {
                          providerID,
                          recordID,
                          submittedOn,
                          pending,
                          server,
                          builtIn,
                          status,
                          instanceID,
                          connected,
                          shape,
                        };
  }

  /**
   * The table's conditions, each on its own; the expected row is the first
   * that holds, and `resolving` when none does.
   */
  function expected({
    providerID,
    recordID,
    submittedOn,
    pending,
    server,
    builtIn,
    status,
    instanceID,
    connected,
    shape,
  }: Combination): ActualyzeRow {
    const ready = server === "ready";
    // A record of another provider than the shown one counts as no record.
    const rec = ready && recordID === providerID ? shape : undefined;
    const current = rec?.current === true;
    // The marker's epoch at submit is 1, and the payload at submit was i1's.
    const baseline = instanceID === "i1" && submittedOn === providerID ? 1 : -1;
    const rows: Array<[ActualyzeRow, boolean]> = [
      ["saving", pending === "saving"],
      ["unconfirmed", pending === "unconfirmed"],
      ["server-unavailable", server === "unavailable"],
      // Another definition of actualyze concerns only that provider.
      [
        "not-managed",
        ready && builtIn === "foreign" && providerID === "actualyze",
      ],
      [
        "checking",
        pending === "saved" &&
          (!rec || !current || rec.credentialEpoch <= baseline),
      ],
      [
        "no-key",
        server !== "loading" &&
          connected === false &&
          (!rec || rec.credentialSource === "none"),
      ],
      [
        "resolving",
        connected === true &&
          (!rec ||
            (ready && status === "pending") ||
            rec.credentialSource === "unresolved" ||
            !current),
      ],
      ["discovering", current && rec.discovering && !rec.lastGood],
      ["failure", current && rec.failure],
      ["empty", current && rec.lastGood && rec.models === 0],
      ["ready", current && rec.lastGood],
    ];
    return rows.find(([, holds]) => holds)?.[0] ?? "resolving";
  }

  it("maps every input combination to exactly the first row whose condition holds", () => {
    const reached = new Map<ProviderID, Set<ActualyzeRow>>(
      PROVIDER_IDS.map((id) => [id, new Set<ActualyzeRow>()]),
    );
    /** Saved keys that left checking only because they were submitted on another provider. */
    let leftByProvider = 0;
    let count = 0;
    for (const combination of combinations()) {
      count += 1;
      const { providerID, recordID, submittedOn, pending, shape } = combination;
      const actual = deriveActualyzeState({
        providerID,
        pending:
          pending === "none"
            ? undefined
            : marker(pending, { providerIDAtSubmit: submittedOn }),
        server: combination.server,
        payload:
          combination.server === "ready"
            ? payload(build(shape, recordID), {
                builtIn: { actualyze: combination.builtIn },
                status: combination.status,
                instanceID: combination.instanceID,
              })
            : undefined,
        connected: combination.connected,
      }).row;
      const want = expected(combination);
      if (actual !== want)
        throw new Error(
          `${JSON.stringify(combination)}: ${actual}, expected ${want}`,
        );
      reached.get(providerID)?.add(actual);
      if (
        pending === "saved" &&
        submittedOn !== providerID &&
        actual !== "checking" &&
        expected({ ...combination, submittedOn: providerID }) === "checking"
      )
        leftByProvider += 1;
    }
    expect(count).toBeGreaterThan(10_000);
    expect(leftByProvider).toBeGreaterThan(0);
    const rows: ActualyzeRow[] = [
      "saving",
      "unconfirmed",
      "server-unavailable",
      "not-managed",
      "checking",
      "no-key",
      "resolving",
      "discovering",
      "failure",
      "empty",
      "ready",
    ];
    expect([...(reached.get("actualyze") ?? [])].sort()).toEqual(
      [...rows].sort(),
    );
    // A run's provider reaches every row but the one for another definition of actualyze.
    expect([...(reached.get("actualyze-start") ?? [])].sort()).toEqual(
      rows.filter((row) => row !== "not-managed").sort(),
    );
  });
});

describe("status line parts", () => {
  const parts = [
    { text: 'key "Laptop"', drop: 2 },
    { text: "5 models", drop: 1 },
    { text: "checked 2 min ago", drop: 3 },
  ];
  const texts = (width: number): string[] =>
    fitStatusParts(20, parts, width).map((part) => part.text);

  it("keeps every part that fits, in order", () => {
    // 20 + 3+12 + 3+8 + 3+17 = 66.
    expect(texts(66)).toEqual([
      'key "Laptop"',
      "5 models",
      "checked 2 min ago",
    ]);
  });

  it("drops the age first, then the key label, never cutting a part", () => {
    expect(texts(65)).toEqual(['key "Laptop"', "5 models"]);
    expect(texts(45)).toEqual(["5 models"]);
    expect(texts(30)).toEqual([]);
  });

  it("drops the later part on a tie and skips empty parts", () => {
    expect(
      fitStatusParts(
        0,
        [
          { text: "aa", drop: 1 },
          { text: "", drop: 9 },
          { text: "bb", drop: 1 },
        ],
        6,
      ).map((part) => part.text),
    ).toEqual(["aa"]);
  });
});

describe("hints", () => {
  it("orders keys as key action, retry, copy link, links, connections, all providers", () => {
    expect(
      inActionOrder(
        ["b", "enter", "c", "y", "l", "r", "k"].map((key) => ({ key })),
      ).map((item) => item.key),
    ).toEqual(["k", "r", "y", "l", "c", "b", "enter"]);
  });

  it("shows the wait in parentheses and only then says to wait", () => {
    expect(retryTitle(59)).toBe("retry (59 s)");
    expect(retryTitle(undefined)).toBe("retry");
    expect(retrySentence(59)).toBe("Retry with r once the wait ends.");
    expect(retrySentence(undefined)).toBe("Retry with r.");
  });
});

describe("links layout", () => {
  const links = actualyzeLinks("https://app.actualyze.ai");

  it("puts URLs beside their labels when every one fits", () => {
    expect(linkLayout(links, 110)).toBe("beside");
  });

  it("puts every URL under its label when any one would not fit", () => {
    // Troubleshooting's URL is the longest; the others would fit at 72.
    const longest = Math.max(...links.map((link) => link.url.length));
    expect(linkLayout(links, 21 + longest - 1)).toBe("below");
    expect(linkLayout(links, 21 + longest)).toBe("beside");
  });
});

describe("sessions", () => {
  it("accepts only the latest session at the location it started in", () => {
    const tracker = createSessionTracker();
    const first = tracker.start("/a");
    expect(tracker.accepts(first, "/a")).toBe(true);
    expect(tracker.accepts(first, "/b")).toBe(false);

    const second = tracker.start("/a");
    expect(second).not.toBe(first);
    expect(tracker.accepts(first, "/a")).toBe(false);
    expect(tracker.accepts(second, "/a")).toBe(true);

    tracker.end(first);
    expect(tracker.active()).toBe(second);
    tracker.end(second);
    expect(tracker.active()).toBeUndefined();
    expect(tracker.accepts(second, "/a")).toBe(false);
  });
});
