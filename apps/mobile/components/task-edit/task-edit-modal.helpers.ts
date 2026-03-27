export function areTaskFieldValuesEqual(left: unknown, right: unknown): boolean {
    if ((left === '' && right == null) || (right === '' && left == null)) {
        return true;
    }
    if (
        Array.isArray(left)
        || Array.isArray(right)
        || (typeof left === 'object' && left !== null)
        || (typeof right === 'object' && right !== null)
    ) {
        return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
    }
    return (left ?? null) === (right ?? null);
}
