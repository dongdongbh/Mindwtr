/**
 * Identity preservation for the merge-input normalizers (#766).
 *
 * The normalizers at the head of `mergeAppDataWithStats` used to rebuild every
 * entity on every cycle, which threw away the object identity the signature
 * caches (sync-signatures.ts) and the SQLite identity-keyed row cache key on.
 * The fix is to build the candidate exactly as before and hand back the INPUT
 * object when the candidate carries the same values, so an unchanged entity
 * keeps one identity from the store all the way through the merge.
 *
 * Comparison rules, all load-bearing for value parity:
 * - Both key sets are compared. A key the normalizer strips, and a key it adds
 *   as an explicit `undefined`, are both real changes to the emitted shape.
 * - Array values compare element-wise (elements by `Object.is`) so a nested
 *   normalizer returning a fresh-but-equal array does not force a fresh parent.
 * - Nested objects compare by reference, so a nested normalizer must cascade
 *   identity the same way or its parent simply allocates as before — slower,
 *   never wrong.
 */

const sameShallowValue = (left: unknown, right: unknown): boolean => {
    if (Object.is(left, right)) return true;
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
        if (!Object.is(left[index], right[index])) return false;
    }
    return true;
};

export const sameShallowRecord = (input: object, candidate: object): boolean => {
    if (Array.isArray(input) !== Array.isArray(candidate)) return false;
    const inputRecord = input as Record<string, unknown>;
    const candidateRecord = candidate as Record<string, unknown>;
    const candidateKeys = Object.keys(candidateRecord);
    if (Object.keys(inputRecord).length !== candidateKeys.length) return false;
    for (const key of candidateKeys) {
        if (!Object.prototype.hasOwnProperty.call(inputRecord, key)) return false;
        if (!sameShallowValue(inputRecord[key], candidateRecord[key])) return false;
    }
    return true;
};

/** Returns `input` when the freshly normalized `candidate` is value-identical to it. */
export const preserveShallowIdentity = <T>(input: unknown, candidate: T): T => (
    candidate !== null
    && typeof candidate === 'object'
    && input !== null
    && typeof input === 'object'
    && sameShallowRecord(input as object, candidate as object)
        ? (input as T)
        : candidate
);
