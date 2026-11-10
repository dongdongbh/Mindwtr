# Mobile Preview completion render stability, November 10, 2026

The project picker no longer causes extra renders of the heavy editor Preview
tab. Its completion callback now retains its identity while picker state changes.
The existing large-store render-count assertion is unchanged.

## Reproduction and result

Source baseline: `50582c0db`. The isolated checkout was
`/home/dd/worktrees/Mindwtr/preview-render-stability`, with Node 22.23.4,
Bun 1.3.3 and Vitest 4.1.12. The existing 5,000-task mobile fixture and React
test renderer supplied the workload; this run did not use a native app binary.

Before the fix, `does not rerender heavy editor tabs when dismissing the project
picker` expected the Preview render count to remain at 2 but observed 4. The
inline completion callback was the changing prop passed to the memoized tab.
After moving that callback into `useCallback`, all six performance tests pass,
including the unchanged picker assertion. No thresholds or assertions changed.
The measured runs ran without concurrent builds or other test suites.

## Correctness and test portability

The broader editor suite exposed an existing failure on the same baseline:
`keeps an in-flight Save even after its submitted draft is reverted`. The new
completion submission lock also blocked edits during an ordinary Save. A failed
Save then left the editor dirty when its draft should have returned to the saved
value, preventing the existing blur-close behavior.

The lock now records the submission mode. Ordinary Save retains its established
draft-edit behavior. Completion, completion retries and Cancel keep their draft
guards; every in-flight submission still blocks another submission. The existing
ordinary Save regression and all completion persistence/retry tests pass.

The real SQLite completion fixture now uses `mkdtempSync` under `os.tmpdir()`
instead of a developer-specific home path. Local commands set `TMPDIR` to a
disk-backed directory under `/home/dd`; CI may use its own writable temp root.

## Validation

All commands ran through RTK with
`TMPDIR=/home/dd/tmp/preview-render-stability`.

- `MINDWTR_PERF_TEST=1 bun --cwd apps/mobile test tests/large-store-performance.test.tsx --maxWorkers=1`: 6 passed.
- `bun --cwd apps/mobile test components/task-edit/use-task-edit-preview-completion.test.tsx components/task-edit-modal.test.tsx components/task-edit/TaskEditViewTab.test.tsx components/task-edit/TaskEditHeader.test.tsx --maxWorkers=1`: 102 passed, including 77 modal and 4 real SQLite tests.
- `bun run typecheck:mobile`: passed.
- `bun run lint:mobile`: passed, 0 errors and the same 69 warnings as the initial run.
- No-comments policy: 3 changed source files checked, 0 violations.

Raw logs are retained locally in
`/home/dd/worktrees/Mindwtr/preview-render-stability-logs`: `red.log`,
`control-blur.log`, `perf-final.log`, `completion-final.log`,
`typecheck-final.log`, `lint-final.log` and `comments-final.log`.

This establishes a deterministic reduction in redundant React renders and the
focused editor behavior. It does not establish native interaction latency or
remote CI status. The next gate is CI on the integrated commit; no further
performance change is proposed from this result.
