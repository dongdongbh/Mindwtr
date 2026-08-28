import { describe, expect, it } from 'vitest';

import {
    advanceProcessInboxSession,
    createProcessInboxSession,
    enterProcessInboxStep,
    getProcessInboxCurrentCandidate,
    getProcessInboxRemainingCandidates,
    goBackProcessInboxStep,
    openProcessInboxTask,
    selectProcessInboxCandidates,
    skipCurrentProcessInboxTask,
    startProcessInboxSession,
} from './process-inbox-session';

type Candidate = { id: string; title: string };
type Step = 'actionable' | 'refine' | 'decide';

const candidates: Candidate[] = [
    { id: 'one', title: 'One' },
    { id: 'two', title: 'Two' },
    { id: 'three', title: 'Three' },
];

describe('Process Inbox session', () => {
    it('builds the session queue from live Inbox tasks and a platform visibility predicate', () => {
        const queue = selectProcessInboxCandidates([
            { id: 'one', status: 'inbox', title: 'One' },
            { id: 'done', status: 'done', title: 'Done' },
            { id: 'deleted', status: 'inbox', deletedAt: '2026-07-15', title: 'Deleted' },
            { id: 'hidden', status: 'inbox', title: 'Hidden' },
        ], (task) => task.id !== 'hidden');

        expect(queue.map(({ id }) => id)).toEqual(['one']);
    });

    // #1089: an incubated item is Someday with a return date. When that date
    // arrives it belongs in the clarify pass — the question it was parked with
    // was "decide this later", and this pass is where deciding happens.
    it('includes an incubated item once its return date arrives, and not before', () => {
        const now = new Date('2026-09-10T09:00:00.000Z');
        const queue = selectProcessInboxCandidates([
            { id: 'captured', status: 'inbox', title: 'Captured' },
            { id: 'due', status: 'someday', reviewAt: '2026-09-10', title: 'Mom\'s birthday' },
            { id: 'later', status: 'someday', reviewAt: '2026-12-01', title: 'Not yet' },
            { id: 'undated', status: 'someday', title: 'Plain someday' },
            { id: 'deleted', status: 'someday', reviewAt: '2026-09-01', deletedAt: '2026-09-02', title: 'Gone' },
            { id: 'waiting-due', status: 'waiting', reviewAt: '2026-09-01', title: 'Chased' },
        ], () => true, now);

        expect(queue.map(({ id }) => id)).toEqual(['captured', 'due']);
    });

    it('starts at the first candidate and resets task-local navigation', () => {
        const session = startProcessInboxSession(candidates, { entryStep: 'refine' as Step });

        expect(session.currentTaskId).toBe('one');
        expect(session.currentStep).toBe('refine');
        expect(session.stepHistory).toEqual([]);
        expect(getProcessInboxCurrentCandidate(session, candidates)?.title).toBe('One');
    });

    it('advances in candidate order while excluding the current and skipped tasks', () => {
        const started = startProcessInboxSession(candidates, { entryStep: 'refine' as Step });
        const skipped = skipCurrentProcessInboxTask(started, candidates, { entryStep: 'refine' });
        const advanced = advanceProcessInboxSession(skipped, candidates, { entryStep: 'refine' });

        expect(skipped.currentTaskId).toBe('two');
        expect([...skipped.skippedTaskIds]).toEqual(['one']);
        expect(advanced.currentTaskId).toBe('three');
        expect(getProcessInboxRemainingCandidates(skipped, candidates).map(({ id }) => id)).toEqual([
            'two',
            'three',
        ]);
    });

    it('advances monotonically when earlier candidates are still in the live list', () => {
        const started = startProcessInboxSession(candidates, { entryStep: 'refine' as Step });
        const second = advanceProcessInboxSession(started, candidates, { entryStep: 'refine' });
        const third = advanceProcessInboxSession(second, candidates, { entryStep: 'refine' });

        expect(second.currentTaskId).toBe('two');
        expect(third.currentTaskId).toBe('three');
    });

    it('does not reopen a visited candidate when the current task leaves the queue', () => {
        const started = startProcessInboxSession(candidates, { entryStep: 'refine' as Step });
        const second = advanceProcessInboxSession(started, candidates, { entryStep: 'refine' });
        const withoutCurrent = [candidates[0], candidates[2]];

        const reconciled = advanceProcessInboxSession(second, withoutCurrent, { entryStep: 'refine' });

        expect([...second.visitedTaskIds]).toEqual(['one', 'two']);
        expect(reconciled.currentTaskId).toBe('three');
    });

    it('restarts from the first eligible candidate when the current task leaves the queue', () => {
        const started = startProcessInboxSession(candidates, { entryStep: 'refine' as Step });
        const remaining = candidates.slice(1);

        expect(advanceProcessInboxSession(started, remaining, { entryStep: 'refine' }).currentTaskId).toBe('two');
    });

    it('finishes with a null current task when no candidates remain', () => {
        const session = openProcessInboxTask(
            createProcessInboxSession<Step>('actionable'),
            'three',
            'refine',
        );

        expect(advanceProcessInboxSession(session, candidates.slice(2), { entryStep: 'refine' }).currentTaskId).toBeNull();
    });

    it('pushes and pops guided steps without mutating prior state', () => {
        const started = startProcessInboxSession(candidates, { entryStep: 'refine' as Step });
        const deciding = enterProcessInboxStep(started, 'decide');
        const backed = goBackProcessInboxStep(deciding);

        expect(started.currentStep).toBe('refine');
        expect(started.stepHistory).toEqual([]);
        expect(deciding.currentStep).toBe('decide');
        expect(deciding.stepHistory).toEqual(['refine']);
        expect(backed.currentStep).toBe('refine');
        expect(backed.stepHistory).toEqual([]);
    });

    it('preserves skipped tasks while opening a new task and clears its step history', () => {
        const skipped = skipCurrentProcessInboxTask(
            startProcessInboxSession(candidates, { entryStep: 'refine' as Step }),
            candidates,
            { entryStep: 'refine' },
        );
        const deciding = enterProcessInboxStep(skipped, 'decide');
        const reopened = openProcessInboxTask(deciding, 'three', 'refine');

        expect([...reopened.skippedTaskIds]).toEqual(['one']);
        expect(reopened.currentTaskId).toBe('three');
        expect(reopened.currentStep).toBe('refine');
        expect(reopened.stepHistory).toEqual([]);
    });
});
