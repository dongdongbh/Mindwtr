import type { Area } from '../types';
import type { AIAreaCandidate } from './types';

type AIAreaSource = Pick<Area, 'id' | 'name' | 'deletedAt'>;
type AIDestination = { projectId?: string | null; sectionId?: string | null; areaId?: string | null };

const MAX_AI_AREA_CANDIDATES = 20;
const MAX_AI_AREA_NAME_LENGTH = 120;
const MAX_AI_AREA_ID_LENGTH = 500;

const hasDestination = (destination?: AIDestination): boolean => Boolean(
    destination?.projectId || destination?.sectionId || destination?.areaId,
);

export function getAIAreaCandidates(areas: readonly AIAreaSource[], destination?: AIDestination): AIAreaCandidate[] {
    if (hasDestination(destination)) return [];

    const candidates = new Map<string, AIAreaCandidate>();
    for (const { id, name, deletedAt } of areas) {
        if (deletedAt || !id.trim() || id.length > MAX_AI_AREA_ID_LENGTH || !name.trim() || candidates.has(id)) continue;
        const boundedName = name.slice(0, MAX_AI_AREA_NAME_LENGTH).replace(/[\uD800-\uDBFF]$/, '');
        candidates.set(id, { id, name: boundedName });
        if (candidates.size === MAX_AI_AREA_CANDIDATES) break;
    }
    return Array.from(candidates.values());
}

export function resolveSuggestedArea(areaId: unknown, areas: readonly AIAreaSource[], destination?: AIDestination): AIAreaCandidate | undefined {
    if (typeof areaId !== 'string' || !areaId.trim() || hasDestination(destination)) return undefined;
    const area = areas.find((candidate) => candidate.id === areaId && !candidate.deletedAt);
    return area ? { id: area.id, name: area.name } : undefined;
}
