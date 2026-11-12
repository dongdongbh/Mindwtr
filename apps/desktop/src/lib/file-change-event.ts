export function isFileContentChange(event: { type?: unknown }): boolean {
    const type = event.type;
    if (!type || typeof type !== 'object') return true;
    if ('access' in type) return false;
    if (!('modify' in type)) return true;
    const modify = type.modify;
    return !(modify && typeof modify === 'object' && 'kind' in modify && modify.kind === 'metadata'
        && 'mode' in modify && modify.mode === 'access-time');
}
