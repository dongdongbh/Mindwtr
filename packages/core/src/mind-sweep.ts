

export type MindSweepScope = 'all' | 'personal' | 'work';
export type MindSweepGroupScope = 'personal' | 'work';

export interface MindSweepGroup {
    id: string;
    scope: MindSweepGroupScope;
    titleKey: string;
    promptKeys: string[];
}

const buildGroup = (id: string, scope: MindSweepGroupScope, promptCount: number): MindSweepGroup => ({
    id,
    scope,
    titleKey: `mindSweep.group.${id}.title`,
    promptKeys: Array.from({ length: promptCount }, (_, index) => `mindSweep.group.${id}.p${index + 1}`),
});

export const MIND_SWEEP_GROUPS: MindSweepGroup[] = [
    buildGroup('homeStuff', 'personal', 5),
    buildGroup('peopleLife', 'personal', 5),
    buildGroup('selfCare', 'personal', 5),
    buildGroup('lifeAdmin', 'personal', 5),
    buildGroup('funGrowth', 'personal', 5),
    buildGroup('commitments', 'work', 5),
    buildGroup('workComms', 'work', 5),
    buildGroup('workCraft', 'work', 5),
    buildGroup('workAdmin', 'work', 5),
];

export function getMindSweepGroups(scope: MindSweepScope): MindSweepGroup[] {
    if (scope === 'all') return MIND_SWEEP_GROUPS;
    return MIND_SWEEP_GROUPS.filter((group) => group.scope === scope);
}
