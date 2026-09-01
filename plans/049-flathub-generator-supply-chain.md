# Plan 049: Isolate Flathub generation from publication credentials

> Drift check: `git diff --stat a4ccb8053..HEAD -- .github/workflows/update-flathub.yml scripts/ci`

## Status

- **Priority**: P2 · **Effort**: M · **Risk**: MED (cross-repository release credential and generated package sources) · **Depends on**: none · **Category**: supply chain and release integrity
- **Planned at**: `a4ccb8053`, 2026-08-31

## Why

The Flathub target checkout persists a write-capable repository token in local Git configuration before the workflow installs mutable Python packages and runs the generator toolchain. Although the workflow is not triggered by arbitrary pull requests and the resulting change still goes through a Flathub PR, a compromised dependency could read that credential and alter generated or checked-out content before the final trusted commit and push.

## Design

- Set `persist-credentials: false` on every checkout. The public Flathub checkout must not receive `FLATHUB_REPO_TOKEN`.
- Pin `actions/setup-python` to commit `a309ff8b426b58ec0e2a45f0f869d46889d02405` (v6.2.0) and Python `3.12.14`, so the wheel lock has a stable interpreter target.
- Add a dedicated requirements lock containing exact versions and SHA-256 hashes for every generator runtime/build dependency and transitive dependency. Install it in a temporary virtual environment with `--require-hashes --only-binary=:all:`.
- Install the already commit-pinned local `flatpak-builder-tools/node` package with `--no-deps --no-build-isolation`, using the locked build backend from the virtual environment. Remove mutable pip upgrades, bare dependency installs, and pipx.
- Expose only the virtual environment's `bin` directory to the later generation step.
- Keep the PAT out of all generation and validation environments. In the final publication step only, expose it as `GH_TOKEN` and run `gh auth setup-git --hostname github.com` immediately before push.

## Implementation

1. Add red governance checks for checkout credential persistence, secret placement, immutable Python/tool pins, hash-required binary-only installation, exact hashed requirements, and final-step-only Git authentication.
2. Generate and independently verify a complete Python 3.12 Linux x86_64 wheel lock compatible with the pinned flatpak-builder-tools node package.
3. Update the workflow without changing `update-flathub-checkout.sh` or generated manifest semantics.
4. Exercise the virtual-environment install and generator CLI locally from the pinned upstream checkout.

## Verification

- Focused release-tool-pin and Flathub-checkout tests.
- Full governance suite and `actionlint .github/workflows/update-flathub.yml`.
- Fresh virtual-environment `pip install --require-hashes --only-binary=:all:` followed by local package installation with no dependency/build isolation and a generator `--help` smoke test.
- A credential-policy test proving the PAT is absent before the final publication step.
- `git diff --check`.

## Non-goals and rollback

- No Flathub manifest-format change, generator source ref change, branch policy change, PR auto-merge, or write-token scope expansion.
- No general Python dependency manager adoption for the application.
- The commit is independently revertible and restores the former installation/authentication sequence.

## Stop conditions

- Stop if any resolved dependency lacks a compatible binary wheel with a verifiable hash for the pinned runner.
- Stop if the generator must resolve or execute an undeclared network dependency after the credential becomes available.
- Stop if read-only checkout and late GitHub CLI authentication cannot preserve existing branch update behavior.
