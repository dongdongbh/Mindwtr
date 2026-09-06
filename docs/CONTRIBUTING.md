# Contributing to Mindwtr

Thanks for your interest in improving Mindwtr. This guide covers:

- Before you begin
- Code contribution process
- Development setup and workflow
- Testing and quality checks
- Pull request guidelines
- Documentation and translation contributions

Mindwtr is a Bun monorepo with:

- Desktop app (`apps/desktop`): Tauri + React + Vite
- Mobile app (`apps/mobile`): Expo + React Native
- Shared core package (`packages/core`): state models, storage adapters, and shared logic


## Before you begin

### 1) Follow our community standards

- Read and follow the [Code of Conduct](https://github.com/dongdongbh/Mindwtr/blob/main/.github/CODE_OF_CONDUCT.md).
- Be respectful in issues, discussions, reviews, and commits.

### 2) Report security issues privately

- Do not open public issues for security vulnerabilities.
- Use [SECURITY.md](https://github.com/dongdongbh/Mindwtr/blob/main/SECURITY.md) for responsible disclosure instructions.

### 3) Start with an issue for non-trivial changes

For behavior changes, significant bug fixes, or new features, open (or confirm) an issue first.
This helps avoid duplicated work and keeps changes aligned with project goals.

When opening an issue, include:

- Platform and version (`desktop`, `mobile`, or both)
- Reproduction steps and expected behavior
- Actual behavior
- Screenshots, screen recordings, and logs when relevant

### 4) Keep product fit in mind

Mindwtr focuses on GTD and practical execution, and is built to be **simple by default and powerful when you need it**: progressive disclosure, less by default, no feature creep. *Don't show me a cockpit when I just want to ride a bike.* Contributions are most likely to be accepted when they:

- Keep workflows simple by default
- Avoid unnecessary UI complexity
- Prefer automatic over manual: if the right outcome can be inferred (platform, install channel, existing data, context), the app should just do it — no new setting, no prompt, no extra workflow step or UI control — and reuse an existing switch before minting a new one (for example, update checks adapt to the install channel instead of offering a toggle)
- Preserve data safety and reliability
- Work consistently across platforms when applicable

## Code contribution process

1. Find an issue to work on, or open one for discussion.
2. Fork the repository and create a branch in your fork.
3. Implement the change with focused scope.
4. Run relevant checks locally.
5. Open a pull request to `dongdongbh/Mindwtr:main`.
6. Link the issue in the PR (example: `Fixes #123`).

Branch naming examples:

- `fix/tray-preference-persistence`
- `feature/date-format-setting`
- `docs/contributing-update`

## Development setup and workflow

Run all commands from the repository root.

### Prerequisites

- Bun (workspace/package manager) — use the version in `.bun-version` (currently 1.3.5) or newer
- Node.js 20 or newer — `apps/mcp-server` declares `"node": ">=20"` and is published to npm, so it must build and run on plain Node
- Python 3 — `bun run verify` runs the governance tests, which include `scripts/ci/google-play-edit.test.py`
- Git
- Rust toolchain (required for Tauri desktop build/dev)
- System webview dependencies for Tauri on your OS
- On Windows: the Visual Studio 2022 C++ build tools. The 2026 toolchain currently fails to link the `whisper-rs` transcription bindings (LNK1120 unresolved C-runtime externals), so pin the MSVC v143 toolset until that is fixed upstream.
- Expo tooling for mobile development
- Android SDK and/or Xcode if building mobile natively

### Install dependencies

```bash
bun install
```

### Run the apps

Desktop (Tauri):

```bash
bun desktop:dev
```

Desktop UI only (browser/Vite):

```bash
bun desktop:web
```

Mobile (Expo):

```bash
bun mobile:start
```

Mobile on device/emulator:

```bash
bun mobile:android
bun mobile:ios
```

### Useful structure reference

- `apps/desktop/src`: desktop UI and desktop integrations
- `apps/mobile`: mobile UI and native bridge code
- `packages/core/src`: shared business logic, store, sync, and utilities
- `scripts/`: release and utility scripts
- `docs/`: markdown docs used by the project

Desktop code must not import `invoke` from `@tauri-apps/api/core` directly. Call
`invokeNative` (rejects when there is no Tauri runtime) or `invokeNativeOr(fallback, ...)`
(resolves to the fallback) from `apps/desktop/src/lib/tauri-invoke.ts`, so each call site
states what it should do in the browser dev build. A ratchet test in
`tauri-invoke.test.ts` fails CI on a raw import.

## Testing and quality checks

Before pushing, run the baseline local verification gate:

```bash
bun run verify
```

`bun run verify` chains typecheck (core, cloud, desktop, mobile, and mcp), lint
for every workspace app, the five workspace unit-test suites, the Rust suite
(`native:test`, a few seconds once the cargo cache is warm), governance and
schema checks, locale parity, and README parity. CI also runs performance
budgets, coverage thresholds, Expo Doctor, and store/workflow metadata checks.

Run `bun run native:test` on its own while iterating on
`apps/desktop/src-tauri/`, and run
`bun run test:perf` for list, store, recurrence, or other hot-path changes.
`bun run test:e2e` needs a browser and remains a separate optional gate.

While iterating, the per-area commands below are faster.

Desktop lint:

```bash
bun run --filter mindwtr lint
```

Desktop tests (single pass, non-watch):

```bash
bun run --filter mindwtr test -- --run
```

Core tests:

```bash
bun run --filter @mindwtr/core test
```

Mobile tests:

```bash
bun run --filter mobile test
```

Optional e2e:

```bash
bun run test:e2e
```

## Coding conventions

- TypeScript first.
- Prefer functional React components and hooks.
- Keep imports grouped: external, workspace/internal, then relative.
- Match file-local formatting conventions:
  - desktop/core usually 4 spaces
  - mobile usually 2 spaces
- Keep code comments concise and only where logic is non-obvious.
- Favor accessibility-oriented test queries (`getByRole`, `getByLabelText`).
- Mobile popups: any transparent-modal popup that contains a `TextInput` must use the shared `useAndroidKeyboardInset` hook so it stays above the Android soft keyboard.
- Markdown editor changes need regression tests for the historical failure modes (cursor jump on tap, scroll-into-view, keyboard-height padding, toolbar timing) — these have each shipped as production bugs before.

Naming:

- Components/providers: `PascalCase`
- Hooks: `useSomething`
- Utility modules: kebab-case (example: `storage-adapter.ts`)
- Tests: mirror source filename with `.test.ts`/`.test.tsx`

## LLM-assisted coding ("vibe coding")

Mindwtr is not strictly against LLM-assisted coding. LLM tools are improving quickly and can be productive when used correctly.

If you use LLM/coding agents for contributions, follow these rules:

1. Do not use web chat interfaces as your main coding tool.
   Use coding agents in an IDE or CLI with repository indexing and full codebase context.
2. Use coding-focused agents, not general chat models.
   Example: use Codex or Claude Code agent for coding tasks, not generic chatbot mode.
3. Start with a clear implementation goal.
   Define the bug/feature, expected behavior, and intended implementation before prompting.
4. Avoid over-engineering.
   Prefer small, maintainable changes that match Mindwtr's "simple by default" philosophy.
5. YOU review the output before opening a non-Draft PR.
   Do not request review until you have read and understood every generated change, run relevant tests, and verified behavior on real devices/platforms. You are responsible for the code you submit, not the tool.
6. Remove verbosity and blathering.
   Strip filler from code comments, documentation, PR descriptions, and commit messages. All of these — including names — should be concise, clear, and contain useful information, nothing more.
7. Remove and deduplicate redundant code, tests, and explanations.
   Explicitness and clarity are good; verbosity, over-explanation, and redundancy are bad.
8. Keep security in scope.
   Do not introduce insecure defaults, unsafe parsing, token leaks, or new attack surfaces.

## Pull request guidelines

All submissions go through GitHub pull requests and maintainer review.

Please keep PRs small and focused:

- One bug fix, one feature, or one isolated refactor per PR
- Avoid bundling unrelated changes

Before opening a PR:

- Ensure relevant checks pass locally
- Rebase/merge your branch as needed to resolve conflicts
- Verify no unrelated files are included

In your PR description, include:

- What changed
- Why it changed
- Linked issue (`Fixes #...`)
- Test evidence (commands run and outcomes)
- Screenshots/recordings for UI changes
- Platform impact (`desktop`, `mobile`, `core`, or combinations)

Commit style:

- Use Conventional Commits when possible
- Examples:
  - `fix(desktop): persist tray preference on macOS`
  - `feat(core): add date format normalization`
  - `docs: clarify sync troubleshooting`

## Contributor License Agreement

Before we can merge your pull request, you'll need to sign our
[Contributor License Agreement (CLA)](https://gist.github.com/dongdongbh/0446c35e1d5c1a73c344b16cba4aeeaa).

This is a one-time process — CLA Assistant will automatically check
when you open a PR and prompt you if needed. Signing takes about
30 seconds via your GitHub account.

### Why a CLA?

Mindwtr is free, open-source, and licensed under AGPL-3.0. The CLA
ensures the project has the flexibility to explore sustainability
options (like dual licensing) in the future, so we can keep the
project alive long-term. You retain full ownership of your
contributions — the CLA just grants the project a license to use them.

The core of Mindwtr will always remain available under an
OSI-approved open-source license.

## Documentation contributions

Documentation updates are welcome in the docs site repo, `README.md`, `README_zh.md`, and repository-local docs.

Most user-facing documentation should go in the Mindwtr web docs source, which builds the public docs site at https://docs.mindwtr.app/. Use this repository's `docs/` directory for repository-local documentation such as contribution guides, architecture summaries, ADRs, and release notes. The `wiki/` directory holds only the retired GitHub Wiki's landing page, which points readers to the docs site; do not add content pages there.

When changing docs:

- Keep instructions accurate and runnable
- Prefer concrete examples over vague guidance
- Validate links
- Update both English and Chinese docs when the content is mirrored
- Keep `README.md` and `README_zh.md` heading structure aligned; CI runs `bun run docs:check-readme`
- Prefer updating the [Mindwtr web docs source](https://github.com/dongdongbh/mindwtr-web/tree/main/docs) when the content is public user/developer documentation

Useful references:

- [Official docs](https://docs.mindwtr.app/)
- [Docs source](https://github.com/dongdongbh/mindwtr-web/tree/main/docs)
- [Developer Guide](https://docs.mindwtr.app/developers/developer-guide)
- [Architecture](https://docs.mindwtr.app/developers/architecture)

## Translation contributions

Most translation strings live in:

- [`packages/core/src/i18n/locales/`](https://github.com/dongdongbh/Mindwtr/tree/main/packages/core/src/i18n/locales/)

When updating translations:

- Keep placeholders and interpolation keys unchanged
- Keep command tokens intact where parser behavior depends on English commands
- For a new language, register the locale in the shared i18n registries, date locale mapping, desktop/mobile language pickers, and locale parity checks
- After changing any `starter.*` string, run `bun run scripts/i18n-locale-parity.ts --fix` to regenerate `packages/core/src/i18n/starter-seed-strings.ts`. That file is generated, never hand-edited, and `bun run i18n:check` fails until it is back in sync
- Run `bun run i18n:check` and relevant core i18n tests
- Confirm UI still fits in small mobile layouts

## Need help?

If you are unsure about scope or implementation details:

- Open a GitHub issue with a short proposal
- Join community chat on Discord: https://discord.gg/gc4h5t58PR
- Ask for maintainer feedback before implementing large changes

Thanks again for contributing to Mindwtr.
