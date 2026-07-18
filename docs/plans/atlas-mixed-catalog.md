# Atlas Mixed-Catalog Discovery Plan

## Goal

Restore authoritative Atlas metadata when an OpenAI-compatible provider exposes
a mixed catalog. Auto-detection should select the Atlas probe when at least one
valid model entry reports `owned_by: "atlas"`. In auto mode, the probe should
request details only for those Atlas-owned entries, while all other entries
remain discovered and use the existing models.dev fallback. Explicit
`probe: "atlas"` remains a manual override and retains its current all-model
behavior.

## Current Behavior

The original endpoint returned a catalog whose models all reported the Atlas
owner. It now returns a larger catalog with several owners. The generic
fingerprint logic requires every model to report the same recognized owner, so
`probe: "auto"` no longer selects Atlas. Discovery still adds the models, but
none receive authoritative context or output limits, and capability flags come
only from models.dev matching.

The detail endpoint still provides limits and capability booleans for
Atlas-owned entries. Entries owned by other backends generally return no such
metadata. Requesting details for the whole mixed catalog also consumes the
remote rate-limit budget without improving those foreign-owner models.

## Constraints

- Keep the generic unanimous-owner rule for oMLX, vLLM, SGLang, llama.cpp,
  KoboldCpp, and Ollama fingerprints.
- Treat only the exact owner string `atlas` as the mixed-catalog signal. Do not
  infer Atlas from model names or unrelated owners.
- In auto mode, fetch detail metadata only for list entries whose owner is
  exactly `atlas`. Keep explicit Atlas probing backward compatible by allowing
  it to inspect every safe listed ID.
- Continue to validate detail identity and owner before applying metadata.
- Preserve bounded concurrency, request timeouts, abort propagation, per-model
  failure isolation, safe model IDs, and authoritative-false sentinels.
- Do not add private endpoint or company identifiers to source, tests, docs,
  commit messages, or release notes. Use `Atlas` and `atlas.test` only.
- Do not invent limits or capabilities for non-Atlas entries. Their existing
  models.dev fallback behavior remains unchanged.

## Approach

1. **Recognize Atlas within mixed catalogs** in
   `src/probes/fingerprint.ts`.
   - Build the owner set from valid list entries as today.
   - Return `atlas` when any entry has the exact owner `atlas`, before applying
     the generic unanimous-owner rule or the llama.cpp non-standard-field
     tiebreaker.
   - Leave all other recognized owners subject to unanimous ownership.
   - Keep the existing prototype-safe map lookup and abort behavior.
   - Treat exact Atlas ownership as a trusted detection signal. A failed detail
     response does not revoke `DiscoverySnapshot.detectedServer`; the snapshot
     may report `atlas` even when that run applies no Atlas metadata.

2. **Carry probe-selection mode into probe context** through
   `src/probes/types.ts` and `src/discover.ts`.
   - Add a narrow optional field such as
     `probeSelection?: "auto" | "explicit"` to `ProbeContext`.
   - Derive it once from the configured value before resolution:
     `probeType === "auto" ? "auto" : "explicit"`. Do not derive it from the
     detected server. This mapping applies to unanimous and mixed Atlas
     catalogs alike.
   - Keep the field optional so existing probes and direct unit calls remain
     compatible.
   - Treat correct auto-mode propagation as a safety invariant. Discovery-level
     tests must fail if a future refactor drops the field and restores
     all-catalog fan-out.

3. **Limit auto-selected Atlas requests to Atlas-owned entries** in
   `src/probes/atlas.ts`.
   - When `context.probeSelection === "auto"`, filter with the exact predicate
     `model?.owned_by === "atlas"` before extracting and deduplicating IDs.
     Missing, padded, differently cased, and malformed owners are excluded.
     Use the same exact-match predicate for fingerprinting and filtering so the
     two decisions cannot diverge.
   - When selection is explicit or unspecified, retain the current behavior of
     probing every safe listed ID. This preserves the manual override and the
     existing direct-probe contract.
   - In auto mode, return `EMPTY_RESULT` immediately after filtering when the
     Atlas-owned subset is empty, before building headers or starting workers.
   - Reuse the existing safe-ID checks, eight-worker pool, abort signal,
     bounded body reads, response validation, and per-item error handling.

4. **Cover fingerprint decisions** in
   `test/probes/fingerprint.test.ts`.
   - A mixed catalog containing Atlas and foreign owners selects Atlas without
     Tier 2 HTTP requests.
   - Replace the existing test that expects Atlas plus a missing owner to be
     inconclusive. The new expected result is Atlas because one exact
     Atlas-owned entry is sufficient for auto mode.
   - A mixed catalog with recognized non-Atlas owners remains inconclusive.
   - Prototype-key and unknown owners remain rejected when no exact Atlas entry
     is present.
   - `Atlas`, ` atlas`, `atlas `, and similar strings do not match the exact
     lowercase owner.
   - Atlas remains higher priority than unrelated non-standard fields in a
     foreign-owner entry.

5. **Cover selection-aware detail requests** in
   `test/probes/atlas.test.ts`.
   - Auto mode with a mixed list requests each unique Atlas-owned model exactly
     once.
   - Foreign-owner and missing-owner entries produce no detail requests.
   - The result contains metadata only for validated Atlas details.
   - Auto mode with no Atlas ownership returns empty without issuing requests.
   - Explicit mode still requests safe IDs regardless of listed owner, covering
     both mixed and ownerless catalogs. Include an ownerless entry to make the
     contrast with auto mode explicit.
   - An Atlas detail failure or `429` does not remove successful siblings. This
     verifies existing non-OK isolation; do not add startup retries or backoff.
   - Existing concurrency, cancellation, malformed-ID, reserved-ID, numeric
     validation, and authoritative-false tests continue to pass.

6. **Verify end-to-end discovery** in `test/discover.test.ts`.
   - Use a compact mixed catalog with Atlas and foreign-owner entries.
   - Assert every valid list entry is still added to provider models.
   - Assert Atlas entries receive context, output, modalities, tool use, and
     reasoning from detail responses.
   - Supply a models.dev fixture and assert a foreign-owner model receives
     fallback capabilities but no limits. Count detail requests through the
     real discovery path and assert zero foreign-owner detail URLs, so dropping
     `probeSelection` cannot pass unnoticed. Assert Atlas requests use the
     encoded `/v1/models/{id}` detail path.
   - Assert an Atlas model with authoritative false capability values rejects a
     conflicting models.dev fallback.
   - Assert an Atlas model whose detail request fails or returns `429` remains
     eligible for models.dev fallback.
   - Assert `DiscoverySnapshot.detectedServer` records `atlas` for the mixed
     catalog.
   - Add a single spoofed Atlas owner whose detail fails identity validation.
     Assert no Atlas metadata is applied while the snapshot still records the
     trusted list-level Atlas detection signal.
   - Add an explicit `probe: "atlas"` discovery case with an ownerless or
     foreign-owner entry. Assert its detail endpoint is requested, valid
     metadata is applied, `probeType` is `atlas`, and `detectedServer` remains
     unset because fingerprinting did not run.

7. **Update public behavior documentation** in `README.md`, `CONTRIBUTING.md`,
   and probe guidance only where the contract changes.
   - Explain that auto-detection supports mixed catalogs containing explicitly
     Atlas-owned entries.
   - State that auto-selected detail probing is restricted to the Atlas-owned
     subset, while explicit Atlas probing remains a manual all-model override.
   - Update the Tier 1 detection description or diagram in `CONTRIBUTING.md` to
     show the Atlas exception before the generic unanimous-owner rule.
   - Avoid runtime model counts, rate-limit values, private names, and endpoint
     addresses.

8. **Run local and live verification** without persisting credentials or live
   response data.
   - Run focused fingerprint, Atlas probe, and discovery tests.
   - Run `npm run check`, `npm run compile`, and `npm pack --dry-run --json`.
   - Use a one-off local fetch wrapper to count normalized request paths and
     response statuses without serializing headers, bodies, credentials,
     endpoint addresses, or model IDs. Normalize detail paths to a fixed form
     such as `/v1/models/:id`. Run at most one live config-hook observation
     after the quota window has reset and record only aggregate counts and
     elapsed time.
   - Treat a live `429` or latency spike as an environmental observation, not a
     deterministic test failure. Do not retry repeatedly. The deterministic
     tests must prove request-count bounds and the five-second abort behavior.
   - Read confidentiality patterns from a permission-restricted file outside
     the repository and run count-only scans. Cover the worktree including
     untracked files, the index, the release commit range, all reachable refs,
     and reflog-reachable objects without printing matched text.

9. **Apply the normal release gate** after implementation.
   - Run independent QA tests for the changed decision logic and external I/O.
   - Run Opus and GPT code reviewers in parallel, address every blocker and
     issue, and repeat until both are clean.
   - Use a minor version bump because mixed-catalog support adds observable
     auto-detection behavior while preserving explicit probing. Update both
     `package.json` and `package-lock.json`.

## Risks

- An unrelated aggregator could label one model with the Atlas owner and cause
  a false-positive detection. Exact Atlas ownership is treated as trusted, so
  the provider snapshot will report Atlas even if detail validation fails. The
  probe limits metadata impact and request volume by requesting and accepting
  auto-mode metadata only for exact Atlas-owned entries whose detail response
  repeats the expected ID, object type, and owner.
- Foreign-owner entries will retain partial metadata because their detail
  responses do not currently expose authoritative limits. The change must leave
  those fields unknown rather than guessing.
- Remote rate limiting remains possible. Filtering before fan-out reduces the
  request count, while existing bounded concurrency and per-model isolation
  handle rejected requests.
- A future owner-contract change could make Atlas ownership disappear entirely.
  Auto-detection should then decline the probe. Explicit probing remains the
  manual escape hatch and may issue more detail requests by design.

## Verification

The change is ready when all of the following hold:

- Mixed Atlas catalogs select `detectedServer: "atlas"`.
- In auto mode, only Atlas-owned IDs receive detail requests. Explicit mode
  retains its existing all-model behavior.
- All valid catalog entries remain discovered.
- Atlas-owned entries receive context and capability metadata when their detail
  response succeeds and supplies valid fields.
- Foreign-owner entries receive no invented limits or Atlas capabilities.
- No probe request continues after the config-hook abort signal.
- Focused tests, the complete adjusted suite, type checking, linting,
  formatting, compilation, and package dry-run all pass.
- Deterministic tests prove the five-second hook bound and bounded request
  count. The live aggregate observation records timing and rate-limit responses
  separately without making either an unconditional release gate.
- Confidentiality scans return zero matches.

## Out of Scope

- Adding provider-specific probes for foreign-owner models in the mixed
  catalog.
- Guessing context or output limits from model names.
- Changing the models.dev matching algorithm.
- Correcting unrelated local provider configuration; that should be handled as
  a separate operational fix.
