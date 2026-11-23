import { describe, expect, it } from 'vitest';
import { getAIAreaCandidates, getTaskCopilotParts, keepTaskCopilotSuggestion, resolveSuggestedArea } from '../ai-task-actions';
import { buildClarifyPrompt } from './prompts';

const work = { id: 'area-work', name: 'Work', color: '#ffffff', order: 1 };
const deleted = { id: 'area-old', name: 'Old', deletedAt: '2026-11-23T00:00:00.000Z' };

describe('AI Area candidates', () => {
    it('projects a bounded list of live, unique IDs and names for an unassigned task', () => {
        const longName = { id: 'area-long', name: `${'a'.repeat(119)}💻 Extra text` };
        const areas = [deleted, work, longName, work, ...Array.from({ length: 30 }, (_, index) => ({ id: `area-${index}`, name: `Area ${index}` }))];

        const candidates = getAIAreaCandidates(areas);
        expect(candidates).toHaveLength(20);
        expect(candidates[0]).toEqual({ id: work.id, name: work.name });
        expect(candidates[1]).toEqual({ id: longName.id, name: 'a'.repeat(119) });
        expect(candidates.at(-1)?.id).toBe('area-17');
        expect(resolveSuggestedArea(longName.id, areas)?.name).toBe(longName.name);
    });

    it.each([{ projectId: 'p1' }, { sectionId: 's1' }, { areaId: 'area-other' }])('keeps a chosen destination %o', (destination) => {
        expect(getAIAreaCandidates([work], destination)).toEqual([]);
        expect(resolveSuggestedArea(work.id, [work], destination)).toBeUndefined();
    });

    it('uses the current Area name and rejects deleted or inexact IDs', () => {
        expect(resolveSuggestedArea(work.id, [{ ...work, name: 'Renamed' }])).toEqual({ id: work.id, name: 'Renamed' });
        expect(resolveSuggestedArea(deleted.id, [deleted])).toBeUndefined();
        expect(resolveSuggestedArea(work.name, [work])).toBeUndefined();
        expect(resolveSuggestedArea(` ${work.id}`, [work])).toBeUndefined();
    });

    it('keeps Area candidates out of a Clarify request with a project', () => {
        const prompt = buildClarifyPrompt({ title: 'Write a status update', projectTitle: 'Release', areas: [work] });
        expect(prompt.areas).toEqual([]);
        expect(prompt.user).toContain('Release');
        expect(prompt.user).not.toContain('areaCandidates');
    });

    it('keeps an Area-only Task Copilot result and labels its chip from live data', () => {
        const suggestion = keepTaskCopilotSuggestion({ areaId: work.id }, false);
        const area = resolveSuggestedArea(suggestion?.areaId, [work]);
        expect(getTaskCopilotParts(suggestion, { tags: [] }, false, area)).toEqual([
            { kind: 'area', value: work.id, label: work.name },
        ]);
        expect(getTaskCopilotParts(suggestion, { tags: [] }, false)).toEqual([]);
    });
});
