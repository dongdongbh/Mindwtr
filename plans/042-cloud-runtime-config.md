# Cloud runtime configuration boundary

## Problem

Mindwtr Cloud converts public numeric environment variables with `Number(...)` at several module and startup sites. Invalid values can become `NaN` or silently fall back to defaults. In particular, a malformed rate limit can make comparisons fail open, while malformed body, timeout, cleanup, and logging thresholds can disable their intended operational controls. Configuration parsing is also interleaved with write-lock/storage setup, so the startup ordering is not explicit.

## Evidence

- `apps/cloud/src/server.ts` reads `PORT`, rate, body-size, namespace, cleanup, timeout, and slow-request values inline in `startCloudServer`.
- `apps/cloud/src/server-config.ts` independently reads collection, pagination, validation, rate-key, and auth-failure limits at module load.
- Most invalid values currently fall back silently; several startup values remain `NaN` and reach request handling.

## Desired behavior

- One typed boundary resolves every public numeric cloud runtime value.
- Empty, non-decimal, non-finite, fractional, out-of-range, and otherwise invalid values stop startup with an error that names the exact environment variable.
- Validation completes before write-lock creation, directory creation/cleanup, or network binding.
- Zero remains valid only for the ephemeral port, slow-log threshold, and explicit any-token namespace disablement.
- Existing valid defaults and programmatic startup overrides remain compatible.

## Implementation

1. Add a pure `resolveCloudRuntimeConfig` module with a readonly result type and explicit integer constraints for every numeric environment variable.
2. Resolve module-level validation/pagination/security limits from that boundary in `server-config.ts`.
3. Resolve startup controls once at the beginning of `startCloudServer`, before constructing storage/lock resources.
4. Document fail-closed numeric parsing and keep `.env.example` aligned with the complete supported set.

## Tests

- Table-test every public numeric environment variable and assert malformed values name the exact key.
- Pin valid defaults, dependent defaults, zero allowances, and upper bounds.
- Prove a malformed environment value rejects `startCloudServer` without creating its configured data directory.
- Run the focused cloud config/server tests, cloud typecheck, and cloud lint.

## Non-goals

- Changing valid default limits.
- Adding new operator-facing controls.
- Changing boolean, token, proxy, CORS, or data-directory parsing.

## Risks and rollback

The change intentionally turns previously ignored malformed configuration into a startup error. Operators must correct the named key. Rollback is a single scoped commit, with no data migration or stored-format impact.
