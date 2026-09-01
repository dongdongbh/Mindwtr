# Plan 048: Enforce the Docker build contract

> Drift check: `git diff --stat a0e75c105..HEAD -- .bun-version docker scripts/ci/validate-release-tool-pins.test.js`

## Status

- **Priority**: P2 · **Effort**: S · **Risk**: MED (published container supply chain) · **Depends on**: none · **Category**: reproducibility and release integrity
- **Planned at**: `a0e75c105`, 2026-08-31

## Why

The two Docker builds do not share the repository's Bun version: `.bun-version` is 1.3.5 while both Dockerfiles use 1.3.3. The app Bun base and Nginx runtime are mutable tags, and both container installs may rewrite the lockfile or resolve a different dependency graph because they omit `--frozen-lockfile`. Rebuilding the same commit can therefore execute different toolchains or dependencies.

## Design

- Make both Bun stages use the `.bun-version` release `1.3.5` and the verified multi-architecture digest `sha256:7156fcc0cee0194d390bfaf7f0eeda9a5e383e70cc90f31aad3a2440a033d7dc`.
- Pin the Nginx stage as `1.31.4-alpine` with verified multi-architecture digest `sha256:db35bfc6b2951e7f8a72db5db120288c127ffaeeb4a6d4b95a26fead017d5913`.
- Require `bun install --frozen-lockfile` for the app and `bun install --production --frozen-lockfile` for cloud. Preserve build stages, user ownership, native build flags, and runtime commands.
- Extend the existing release-tool pin governance test to derive the expected Bun tag from `.bun-version`, require a digest on every external base image, and require frozen dependency installation in both Dockerfiles.

## Implementation

1. Add failing governance assertions for version parity, digest pins, and frozen installs.
2. Update only the Docker base references and Bun install flags needed to satisfy the contract.
3. Correct the Docker documentation's Bun version statement.

## Verification

- Focused release-tool pin governance test and full governance suite.
- Build both Docker images from the repository and run their declared health/config checks where practical.
- Confirm the app Nginx config and cloud entrypoint still validate.
- `git diff --check`.

## Non-goals and rollback

- No application dependency upgrade, Alpine package-policy redesign, Compose published-image pin, or container runtime behavior change.
- No switch away from Bun or Nginx.
- The commit is independently revertible and restores the former Docker build inputs.

## Stop conditions

- Stop if a digest is architecture-specific rather than the verified multi-architecture index.
- Stop if frozen installation would require changing `bun.lock` or dropping a required production workspace package.
- Stop if either built image no longer starts with its existing non-root/runtime contract.
