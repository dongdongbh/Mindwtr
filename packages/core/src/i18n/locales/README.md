# Locale Contribution Guide

Mindwtr keeps translations under this folder so community contributions are easy to submit.

- `en.ts`: English source strings (base dictionary).
- `zh-Hans.ts`: Full Simplified Chinese dictionary.
- `zh-Hant.ts`: Full Traditional Chinese dictionary.
- `zh.ts`: Legacy alias that points to `zh-Hans.ts` for backward compatibility.
- `*.ts` for other languages: manual override dictionaries.

For languages using overrides, prefer adding explicit translations for all keys.
Any missing key falls back to the English source string at runtime.

## How to contribute a language fix

1. Open the language file (for example `fr.ts`).
2. Add or update keys in `<lang>Overrides`.
3. Keep command tokens in English where applicable (`/start:`, `/due:`, `/review:`, `/note:`, `/next`, `@context`, `#tag`, `+Project`).
4. Run tests:

```bash
bun run --filter @mindwtr/core test
```

## How to find new strings to translate

You do not need to compare `en.ts` and `<lang>.ts` line by line.

From the repo root, run:

```bash
bun run scripts/i18n-locale-diff.ts de
```

Replace `de` with another locale code such as `fr`, `it`, or `nl`.

The script reports:

- keys that exist in `en.ts` but are missing from the locale file and currently fall back to English
- keys that exist in the locale file but no longer exist in `en.ts`
