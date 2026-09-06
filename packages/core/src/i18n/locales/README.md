# Locale Contribution Guide

Mindwtr keeps translations under this folder so community contributions are easy to submit.

- `en.ts`: English source strings (base dictionary). It is the only file that defines keys.
- `zh-Hans.ts`, `zh-Hant.ts`: full Chinese dictionaries.
- Every other `*.ts`: an override dictionary. A key the file does not translate falls back to English on screen.

Each locale carries a `translatedKeyFloor` in `i18n-locales.ts`, and CI enforces it. It is an absolute **number of keys**, not a percentage: deleting a translation always fails the gate, and adding a new English string never does. Raise a floor when real translation work lands; never lower it. A floor of `'all'` means every key in `en.ts` has to be translated. The Chinese files carry it because they are full dictionaries; `es`, `fa`, `ja` and `sv` carry it because they are maintained at full parity even though they load as override dictionaries.

## What an untranslated string shows

A key a locale has not translated renders as the English copy, not as anything machine-derived. `resolveI18nText` in `packages/core/src/i18n/index.ts` is the one home for that policy, and its miss order is: an explicit fallback the caller passed, then the English string, then the raw key so a genuinely missing key stays visible. So an incomplete locale reads as clean mixed-language UI, and adding a translation is always an improvement over the English it replaces.

## How to contribute a language fix

1. Open the language file (for example `vi.ts` for Vietnamese or `fr.ts` for French).
2. Add or update keys in `<lang>Overrides`. Keep the keys in the same order as `en.ts`, and keep the file's existing line format. Do not reformat lines you did not translate; a reformat hides your real changes in a 2,500-line diff.
3. For a new language, start with one entry in `i18n-locales.ts`. `Language`, `SUPPORTED_LANGUAGES`, the loader's dispatch, both apps' language pickers, and the parity rosters all derive from that table. Four places still need a manual entry: `DATE_LOCALE_BY_LANGUAGE` and `LOCALE_TAG_BY_LANGUAGE` in `date.ts`, `translationsByLocale` in `locale-parity.test.ts`, and the locale's mirrored-English allow-list in `locale-quality.ts` if it needs one.
4. If you touched any `starter.*` string, regenerate the seed table. `starter-seed-strings.ts` is generated and must not be hand-edited; `bun run i18n:check` fails with "starter-seed-strings.ts: out of date" until you run:

```bash
bun run scripts/i18n-locale-parity.ts --fix
```

5. Run the checks below before opening the pull request.

## Checks to run before a pull request

From the repo root:

```bash
bun run i18n:check                                  # key parity, seed drift, and the string checks listed below
cd packages/core && bunx vitest run src/i18n        # the same checks as tests, plus the key floors and loader tests
bun run typecheck:core
bun run lint:core
```

`bun run i18n:check` reports one line per locale. `ok` means the locale passed. Otherwise it names the check and lists the first keys, for example `es: quoted English button labels 3 keys`. Fix the wording of those keys; do not delete the translation to make the line go away. A translation is always better than the English fallback.

What the automated checks catch:

| Check | What it flags | How to fix |
| --- | --- | --- |
| missing / unknown keys | a full-parity locale lacks a key, or a file has a key `en.ts` no longer has | translate the key, or remove the stale one (`--fix` removes stale keys) |
| mirrored English | a value byte-identical to the English one | translate it, or add the key to the locale's allow-list in `locale-quality.ts` if the word is genuinely the same in your language |
| placeholder slots | `{{count}}` or `{name}` missing or invented compared with `en.ts` | keep every slot; rewrite the sentence around it |
| word-substituted English | a Latin-script value that still contains English function words from its source, the mark of an English sentence with single words swapped | retranslate the sentence |
| mixed English | Latin fragments in a non-Latin locale that is still far from complete | translate the fragment |
| missing slash command tokens | `/due:`, `/next`, `/* focus`, `/area:` or a path such as `/v1/data` present in the English source but not in your value | put the token back verbatim |
| quoted English button labels | help text that quotes a button by its English label (`tap "Export Backup"`) while your file translates that button under its own key | quote your translation of the label instead |

## What the checks cannot see

The two full-parity pull requests for German and Spanish passed every automated check and still needed a round of fixes. Reviewers read for the points below, so check them yourself first.

**One word per concept.** The GTD list names are defined once and reused everywhere. Take the word from the defining key and use that same word in every sentence that names the list:

| Concept | Defining keys | Note |
| --- | --- | --- |
| Inbox | `nav.inbox`, `status.inbox`, `inbox.title` | |
| Next Actions | `nav.next`, `next.title`, `status.next` | |
| Waiting | `nav.waiting`, `waiting.title`, `status.waiting` | |
| Someday / Maybe | `nav.someday`, `someday.title`, `status.someday` | |
| Reference | `nav.reference`, `status.reference` | |
| Focus (the view) | `nav.agenda`, `agenda.title`, `tab.next`, `nav.sectionFocus` | the key names say "agenda" and "next" for historical reasons; the English label is Focus |
| Review | `nav.review`, `review.title` | |
| Projects, Areas, Contexts, Tags | `nav.projects`, `nav.contexts`, `projects.title` | |
| Timeline, Board, Calendar | `nav.timeline`, `nav.board`, `nav.calendar` | |
| Done vs Completed | `status.done`, `nav.done` (Done); `list.done` (Completed) | check the English of each key; the Spanish file had them swapped |
| Self-hosted | `settings.syncBackendCloud`, `settings.cloudProviderSelfHosted` | English says Self-Hosted; do not call it "cloud" |

A quick way to find drift: search your file for each of your list words and see whether a second word is used for the same list somewhere else.

**One form of address.** Pick tú or usted, Du or Sie, and use it in every string, including `starter.*`, `onboarding.*`, `mindSweep.*` and `dailyReview.*`. Mixing forms is the most common leftover from older partial files.

**Button labels follow your language's UI convention.** A German button says `Nach Aktualisierungen suchen` (infinitive), not `Suche nach Aktualisierungen` (a command to the user). Look at how your platform's system apps label buttons and match that.

**Keep the meaning, including the small words.** "Optional:", "only", "localhost", "or send it back", "after the selected number of days" all carry meaning. Do not replace a placeholder or a setting-controlled number with a fixed number ("up to 3 tasks" when the limit is a setting). Do not turn a question into a statement when the buttons below answer the question. Do not add an example the English does not have; the Spanish file once invented an example URL that contradicted the hint next to it.

**Parser syntax stays in English.** Command tokens are typed by the user and parsed by Mindwtr: `/start:`, `/due:`, `/review:`, `/note:`, `/link:`, `/energy:`, `/priority:`, `/next`, `/* focus`, `/area:`, `!Area`, and the search operators `status:`, `context:`, `tag:`, `project:`, `due:`. The bracket words in `quickAdd.help` (`<when>`, `<text>`, `<url>`) are part of the syntax too. Example names such as `@home`, `#urgent`, `+Project` and `%Person` may be localized; if you do, keep each one a single word with no spaces, and use the same choice in every key that shows the example (`quickAdd.placeholder`, `bulk.contextPlaceholder`, `taskEdit.contextsPlaceholder`, `contexts.noContexts`).

**Quoted UI labels match the translated button.** When a sentence tells the user to tap a button, quote your own translation of that button's key. The check above catches labels of five characters or more; shorter ones such as "Sync" are yours to catch.

**Product names and identical words.** Brand and protocol names (`WebDAV`, `Dropbox`, `Syncthing`, its menu items `Send & Receive` and `Watch for Changes`, `E-Ink`, theme names) stay as they are. A word that is genuinely the same in your language (`Error`, `General`, `Color` in Spanish) is fine to keep; add that key to your locale's list in `allowedEnglishMirrorKeysByLocale` in `locale-quality.ts` so the mirrored-English check knows it was reviewed. Keep that list narrow and key-based.

## Promoting a locale to full parity

When every key in `en.ts` is translated, set the locale's `translatedKeyFloor` to `'all'` in `i18n-locales.ts`. The language pickers then drop the "partial" marker for that language. From that point on, every new English key must get a translation in your file in the same commit, or the core test suite fails. Mention in the pull request that you are happy to be pinged for those, or the maintainer will fill them in.

## How to find new strings to translate

You do not need to compare `en.ts` and `<lang>.ts` line by line.

From the repo root, run:

```bash
bun run scripts/i18n-locale-diff.ts de
```

Replace `de` with another locale code such as `vi`, `fr`, `it`, or `nl`.

The script reports:

- locale coverage percentage
- keys that exist in `en.ts` but are missing from the locale file and currently fall back to English
- keys that exist in the locale file but no longer exist in `en.ts`

The percentage is informational only. The gate compares the locale's translated **key count** against its `translatedKeyFloor`, so the number to watch when you are clearing a CI failure is the count of missing keys, not the percentage.
