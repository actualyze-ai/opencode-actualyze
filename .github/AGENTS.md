# CI and publishing notes

## npm Trusted Publishing (OIDC)

- Requires Node 24+ (ships npm 11.5.1+). npm 10.x only supports provenance signing via OIDC, not tokenless publishing.
- `NODE_AUTH_TOKEN: ""` in the publish step is critical. `actions/setup-node` injects a placeholder token (`XXXXX-XXXXX-XXXXX-XXXXX`) that overrides OIDC. Setting it to empty string clears it so npm falls through to OIDC auth.
- The 404 error from npm on publish with an invalid token is misleading — it looks like a missing package, not an auth failure. npm returns 404 instead of 401 on PUT with bad tokens.
- `publishConfig.provenance: true` in package.json makes provenance automatic. No `--provenance` flag needed in CI.
- Trusted publisher config on npmjs.com must match exactly: owner, repo, workflow filename. No environment field.

## Workflows

- `ci.yml` runs `npm run check` on every pull request. `release.yml` runs on a `v*` tag push: check, compile, npm publish, GitHub Release. Keep the `release.yml` filename: the npm trusted publisher names it.
- `persist-credentials: false` on `release.yml`: the release job never pushes to git.
- `prepack` lifecycle runs automatically on both `npm publish` and `npm pack`. Our `prepack` script runs `compile` (tsup). So `npm publish` compiles twice in CI (explicit step + lifecycle) — harmless, `--clean` ensures idempotency.

## Tag Rules

- Organization rulesets on `actualyze-ai` apply to every tag. Only maintainers can create one, and tags cannot be moved or deleted.
- No workflow may move, delete, or recreate a tag, so there is no rolling `latest` snapshot release.
- A pushed version tag is final. When its release run fails because of the code, fix it and release the next version.
