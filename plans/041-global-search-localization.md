# Localize desktop Global Search filters

## Problem and evidence

Desktop Global Search renders filter headings, scope choices, due-date choices, active-chip prefixes, and the clear action as hardcoded English. Mobile already uses translation keys for the same filter vocabulary, so the two surfaces drift and desktop remains partly English in every non-English locale.

## Desired behavior

Both platforms must obtain scope and due-preset labels from one exhaustive, pure presentation mapping. Desktop section headings, choices, and active chips must use existing translation keys and match the mobile vocabulary.

## Implementation

1. Add a core unit test that pins every `DuePreset` and `GlobalSearchScope` to its translation key.
2. Add a pure `getGlobalSearchFilterPresentation(t)` helper beside the shared filter model, using exhaustive records and fallbacks.
3. Consume the helper on desktop for headings, options, active chips, and clear action.
4. Replace mobile's duplicate due/scope maps with the same helper without changing its layout or state behavior.
5. Add a desktop component regression for translated headings and the due chip.

## Verification

- Run core Global Search filter tests and desktop Global Search component tests.
- Run mobile Global Search tests if present, both package suites, root typecheck, and localization parity.

## Non-goals

- Add or rename locale keys.
- Change search matching or filter semantics.
- Redesign either filter panel.

## Risks and rollback

The change is presentation-only. Existing locale keys already pass parity checks and mobile already depends on them. Reverting restores duplicated labels and desktop hardcoding.
