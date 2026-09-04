# Plan 069: Delete withParsedProcessInboxFields, the exhaustive guard nothing calls

> Executor: drift check `git diff --stat 992113e77..HEAD -- packages/core/src/process-inbox-workflow.ts packages/core/src/process-inbox-workflow.test.ts packages/core/src/index.ts`.

## Status
- Priority P3 · Effort S · Risk LOW · Category: tech-debt · Planned at `992113e77`, 2026-09-04 (Phase 2 TEST-04)

## Why
`packages/core/src/process-inbox-workflow.ts:126-147` exports `withParsedProcessInboxFields` whose comment promises that a new event type must declare its token handling, but both clarify controllers call `mergeParsedProcessInboxFields` before building the event (`apps/desktop/src/components/views/inbox/useInboxProcessingController.ts` ~:344, `apps/mobile/components/inbox-processing/useInboxProcessingController.ts` ~:709). The only callers are its own tests (`process-inbox-workflow.test.ts:177-243`). The guard guards nothing and misleads readers.

## Steps
1. Confirm zero production callers: `rg -n withParsedProcessInboxFields apps packages --glob '!node_modules'` → only the two core files.
2. Delete the function and its `describe('withParsedProcessInboxFields')` block; if `packages/core/src/index.ts` re-exports it, remove that line; `src/index-exports.test.ts` must stay green.
3. Add one sentence to the `mergeParsedProcessInboxFields` doc comment naming it the single seam both controllers use.
- Verify: `bun run --filter @mindwtr/core test -- src/process-inbox-workflow.test.ts src/index-exports.test.ts`; `bun run typecheck` (all packages); `git diff --check`.

## STOP conditions
- A production caller exists after all; typecheck reveals an app import.
