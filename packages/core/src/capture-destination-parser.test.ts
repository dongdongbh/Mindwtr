import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveCaptureDestination, type CaptureDestination } from './capture-destination';
import { parseQuickAdd, type QuickAddParseOptions } from './quick-add';
import type { Area, Project } from './types';

const fixture: {
    baseline: Extract<CaptureDestination, { kind: 'area' }>;
    projects: Pick<Project, 'id' | 'title'>[];
    areas: Pick<Area, 'id' | 'name'>[];
    cases: { input: string; selected?: CaptureDestination; parseOptions?: QuickAddParseOptions;
        expected: { destination: CaptureDestination; projectToCreate?: string } }[];
} = JSON.parse(readFileSync(new URL('./capture-destination-parser.fixtures.json', import.meta.url), 'utf8'));
const ambiguous: typeof fixture.cases = JSON.parse(readFileSync(new URL('./capture-destination-ambiguity.fixtures.json', import.meta.url), 'utf8'));
const projects: Project[] = fixture.projects.map(project => ({ ...project, status: 'active', color: '#123456',
    order: 0, tagIds: [], createdAt: '', updatedAt: '' }));
const areas: Area[] = fixture.areas.map(area => ({ ...area, order: 0, createdAt: '', updatedAt: '' }));

describe('standalone capture destination grammar agreement', () => {
    it.each([...fixture.cases, ...ambiguous])('$input', ({ input, selected, parseOptions, expected }) => {
        const parsed = parseQuickAdd(input, projects, new Date('2026-11-14T12:00:00.000Z'), areas, { naturalLanguageDates: false, ...parseOptions });
        const result = resolveCaptureDestination({ parsed, projects, areas, selectedAreaId: fixture.baseline.id, destination: selected });
        expect(result.available).toBe(true);
        expect(JSON.parse(JSON.stringify({ destination: result.destination, projectToCreate: result.projectToCreate?.title }))).toEqual(expected);
    });
});
