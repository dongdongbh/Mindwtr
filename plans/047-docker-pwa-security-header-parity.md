# Plan 047: Keep Docker PWA security headers in parity

> Drift check: `git diff --stat 611d8fd3c..HEAD -- apps/desktop/public/_headers apps/desktop/src/security-headers.test.ts docker/app/nginx.conf`

## Status

- **Priority**: P2 · **Effort**: S · **Risk**: LOW · **Depends on**: none · **Category**: security and deployment parity
- **Planned at**: `611d8fd3c`, 2026-08-31

## Why

Hosted static builds receive the repository's Content Security Policy, referrer policy, and browser capability restrictions from `public/_headers`. The same PWA served by the Docker Nginx image receives only MIME-sniffing and framing headers, so deployment choice silently changes the browser security boundary.

## Design

- Treat `apps/desktop/public/_headers` as the authoritative hosted-PWA policy and make the Docker Nginx response policy semantically identical for CSP, MIME sniffing, referrer policy, and permissions policy.
- Retain Nginx's existing `X-Frame-Options` defense and cache behavior.
- Repeat the security headers in every Nginx location that declares `add_header`, because Nginx stops inheriting parent headers there.
- Add a focused parity test that parses the policy rather than relying on fragile whitespace or header order.

## Implementation

1. Add a failing test that compares authoritative security-header values with every Nginx response location.
2. Add the missing CSP, referrer, and permissions headers to the server and both location blocks.
3. Keep asset caching and SPA fallback unchanged.

## Verification

- Focused desktop security-header test.
- Full desktop test suite or its security/config subset plus desktop typecheck.
- Nginx config validation if a local Nginx/container runtime is available.
- `git diff --check`.

## Non-goals and rollback

- No redesign of the existing CSP, new allowed origin, feature enablement, or caching change.
- No change to native Tauri security configuration.
- The commit is independently revertible and restores the prior Docker-only policy.

## Stop conditions

- Stop if parity requires loosening the authoritative hosted policy.
- Stop if any location can return HTML, JavaScript, manifest, media, or assets without the shared policy.
