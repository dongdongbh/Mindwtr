


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


export const preserveShallowIdentity = <T>(input: unknown, candidate: T): T => (
    candidate !== null
    && typeof candidate === 'object'
    && input !== null
    && typeof input === 'object'
    && sameShallowRecord(input as object, candidate as object)
        ? (input as T)
        : candidate
);
