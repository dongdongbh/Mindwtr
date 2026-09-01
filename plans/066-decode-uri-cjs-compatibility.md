# Plan 066: Preserve mobile query parsing after the URI decoder security fix

> Drift check: `git diff --check v1.2.5-rc.2..HEAD`

## Status

- Priority P2; effort S; risk MEDIUM; category dependency/runtime compatibility.
- Validated closure finding after the repository-wide `decode-uri-component@0.5.0` override cleared GHSA-vcc3-ghjq-m6fr but broke CommonJS `query-string@7.1.3` consumers used by React Navigation and Expo Router.

## Why

`decode-uri-component@0.5.0` is the only release patched for GHSA-vcc3-ghjq-m6fr, but it is ESM-only. `query-string@7.1.3` calls the result of `require('decode-uri-component')` as a function, so a clean Node install fails while parsing deep-link query parameters. All older CommonJS decoder releases remain vulnerable and cannot be restored.

## Design

1. Keep React Navigation and Expo Router on their compatible `query-string@7.1.3` API, but patch its CommonJS import to unwrap the default export exposed by decoder 0.5.0.
2. Apply that same minimal patch through Bun's native patched-dependency mechanism and an idempotent mobile npm postinstall verifier; do not add unsupported nested Bun overrides.
3. Keep every decoder lock entry at 0.5.0 so an older vulnerable transitive copy cannot return.
4. Add a governance regression that checks manifest, patch, and lock metadata, resolves query-string from React Navigation's package context, and parses an encoded deep-link query through its CommonJS entry path.

## Verification

- Demonstrate the pre-fix `TypeError: decodeComponent is not a function` with the frozen Bun install.
- Run a frozen Bun install and the dependency governance test.
- Run a clean isolated mobile `npm ci`, inspect resolved package metadata, and execute the query parse smoke from React Navigation's resolution context.
- Run Bun and npm audits, the mobile typecheck, affected navigation/deep-link tests, and `git diff --check v1.2.5-rc.2..HEAD`.

## Non-goals and stop conditions

- Do not reintroduce any `decode-uri-component` release affected by GHSA-vcc3-ghjq-m6fr.
- Do not change unrelated package versions or navigation behavior.
- Stop if the compatibility patch changes `query-string@7.1.3` parse/stringify behavior under the existing focused tests.
