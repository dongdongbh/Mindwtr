
export type AreaOrderIntent = { kind: 'moveUp'; areaId: string }
    | { kind: 'sortName' } | { kind: 'sortColor' };

export function areaOrderIdsForIntent<T extends { id: string; name: string; color?: string | null }>(
    areas: readonly T[], intent: AreaOrderIntent,
): string[] | null {
    if (intent.kind === 'moveUp') {
        const index = areas.findIndex((area) => area.id === intent.areaId);
        if (index <= 0) return null;
        const ids = areas.map((area) => area.id);
        [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]];
        return ids;
    }
    if (intent.kind === 'sortName') return [...areas]
        .sort((a, b) => a.name.localeCompare(b.name)).map((area) => area.id);
    return [...areas].sort((a, b) => {
        const colorA = (a.color || '').toLowerCase();
        const colorB = (b.color || '').toLowerCase();
        if (colorA && colorB && colorA !== colorB) return colorA.localeCompare(colorB);
        if (colorA && !colorB) return -1;
        if (!colorA && colorB) return 1;
        return a.name.localeCompare(b.name);
    }).map((area) => area.id);
}

export function sortAreasForOrderDisplay<T extends { name: string; order: number; deletedAt?: string }>(areas: readonly T[]): T[] {
    return [...areas].filter((area) => !area.deletedAt)
        .sort((a, b) => a.order !== b.order ? a.order - b.order : a.name.localeCompare(b.name));
}
