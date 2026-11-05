import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadTranslations } from './i18n/i18n-loader';
import { flushPendingSave, resetForTests } from './store';
import {
    createContractDriver,
    createCoreDriver,
    loadBulkActionsFixture,
    replayBulkScenario,
} from './task-list-bulk-actions.replay';

const fixture = loadBulkActionsFixture();

describe('React Native selection mode parity', () => {
    const originalTz = process.env.TZ;
    let t: (key: string) => string = (key) => key;
    beforeAll(async () => {
        process.env.TZ = fixture.timeZone;
        const english = await loadTranslations('en');
        t = (key) => english[key] ?? key;
    });
    afterAll(() => {
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    });
    afterEach(async () => {
        vi.useRealTimers();
        await flushPendingSave();
        resetForTests();
    });
    const freezeClock = () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(fixture.now));
    };

    it('the frozen fixture covers every list and action', () => {
        expect(new Set(fixture.scenarios.map((scenario) => scenario.list))).toEqual(new Set(['inbox', 'waiting', 'someday', 'reference', 'done', 'project']));
        const kinds = new Set(fixture.scenarios.flatMap((scenario) => scenario.actions.map((action) => (action[0] === 'organize' ? `organize:${String(action[1])}` : action[0]))));
        for (const kind of ['select', 'range', 'move', 'addTag', 'removeTag', 'delete', 'undo', 'exit', 'moveToSection', 'organize:apply', 'organize:project', 'organize:area', 'organize:quickDate', 'organize:pickDate']) {
            expect(kinds).toContain(kind);
        }
    });

    for (const scenario of fixture.scenarios) {
        it(`core replays "${scenario.name}"`, async () => {
            freezeClock();
            const observed = await replayBulkScenario(fixture, scenario, () => createCoreDriver(t), t);
            expect(observed).toEqual(fixture.observations[scenario.name]);
        });
    }


    for (const scenario of fixture.scenarios.filter((entry) => entry.list !== 'project')) {
        it(`the contract replays "${scenario.name}"`, async () => {
            freezeClock();
            const observed = await replayBulkScenario(fixture, scenario, createContractDriver, t);
            expect(observed).toEqual(fixture.observations[scenario.name]);
        });
    }
});
