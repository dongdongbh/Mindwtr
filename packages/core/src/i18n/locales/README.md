# Locale Contribution Guide

Mindwtr keeps translations under this folder so community contributions are easy to submit.

- `en.ts`: English source strings (base dictionary).
- `zh-Hans.ts`: Full Simplified Chinese dictionary.
- `zh-Hant.ts`: Full Traditional Chinese dictionary.
- `zh.ts`: Legacy alias that points to `zh-Hans.ts` for backward compatibility.
- `*.ts` for other languages: manual override dictionaries. These locales are partial by design; missing keys fall back to English.

English and Chinese are the only full dictionaries today. For languages using overrides, prefer adding explicit translations for all keys, but do not copy English strings into override files as placeholders. CI enforces each partial locale's current coverage floor so newly added English keys cannot silently lower existing coverage.

## When a translation matches English

Some translated UI strings are intentionally identical to English, for example short labels like `Auto` or `Compact`, product names, protocol names, and command tokens. If a translator has reviewed the string and the target-language UI should match English, keep the entry in the locale override file. Coverage counts reviewed override keys, not only strings that visually differ from English.

Mindwtr also checks for verbatim English-looking values so placeholder copies do not ship by accident. If `bun run i18n:check` or `locale-parity.test.ts` flags a deliberately identical translation, add that specific key to the locale-specific mirrored-English allow-list used by both checks. Keep that list narrow and key-based; do not remove reviewed translations just to reduce the warning, and do not broadly ignore all identical strings for a locale.

Parser and command tokens stay in English inside translated help text, for example `/start:`, `/due:`, `/review:`, `/note:`, `/link:`, `/next`, `/area:`, `!Area`, `@context`, `#tag`, and `+Project`.

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

- locale coverage percentage
- keys that exist in `en.ts` but are missing from the locale file and currently fall back to English
- keys that exist in the locale file but no longer exist in `en.ts`
