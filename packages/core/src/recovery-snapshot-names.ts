


export const RECOVERY_SNAPSHOT_FILE_PATTERN = /^data\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})(?:\.(\d{3})(?:\.(\d+))?)?\.snapshot\.json$/u;
export const MAX_RECOVERY_SNAPSHOTS = 5;


export const buildRecoverySnapshotFileName = (date: Date = new Date(), collisionIndex = 0): string => {
    const iso = date.toISOString();
    const [datePart, timePartWithZone] = iso.split('T');
    const safeTime = String(timePartWithZone || '00:00:00.000Z')
        .replace(/Z$/u, '')
        .replace(/:/gu, '-');
    const collisionSuffix = collisionIndex > 0 ? `.${collisionIndex}` : '';
    return `data.${datePart}T${safeTime}${collisionSuffix}.snapshot.json`;
};


export const sortRecoverySnapshotNames = (names: readonly string[]): string[] => names
    .map((name) => {
        const match = name.match(RECOVERY_SNAPSHOT_FILE_PATTERN);
        if (!match) return null;
        return {
            name,
            timestampKey: `${match[1]}.${match[2] ?? '000'}`,
            collisionIndex: Number(match[3] ?? 0),
        };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((left, right) =>
        right.timestampKey.localeCompare(left.timestampKey)
        || right.collisionIndex - left.collisionIndex
    )
    .map(({ name }) => name);


export const recoverySnapshotNamesToPrune = (names: readonly string[], protect: Iterable<string> = []): string[] => {
    const kept = new Set(protect);
    const sorted = sortRecoverySnapshotNames(names);

    const places = Math.max(0, MAX_RECOVERY_SNAPSHOTS - sorted.filter((name) => kept.has(name)).length);
    return sorted.filter((name) => !kept.has(name)).slice(places);
};


export const formatRecoverySnapshotLabel = (fileName: string): string => {
    const match = fileName.match(
        /^data\.(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:\.(\d{3})(?:\.\d+)?)?\.snapshot\.json$/i,
    );
    if (!match) return fileName;
    const [, datePart, hour, minute, second, milliseconds = '000'] = match;
    const localDate = new Date(`${datePart}T${hour}:${minute}:${second}.${milliseconds}Z`);
    return `${localDate.toLocaleDateString()} ${localDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
};
