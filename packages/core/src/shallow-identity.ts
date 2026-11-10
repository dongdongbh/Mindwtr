


const sameShallowValue = (left: unknown, right: unknown): boolean => {
    if (Object.is(left, right)) return true;
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
        if (!Object.is(left[index], right[index])) return false;
    }
    return true;
};

const hasOwnProperty = Object.prototype.hasOwnProperty;

export const sameShallowRecord = (input: object, candidate: object): boolean => {
    if (Array.isArray(input) !== Array.isArray(candidate)) return false;
    const inputRecord = input as Record<string, unknown>;
    const candidateRecord = candidate as Record<string, unknown>;
    const candidateKeys = Object.keys(candidateRecord);
    const inputKeys = Object.keys(inputRecord);
    if (inputKeys.length !== candidateKeys.length) return false;
    for (let index = 0; index < candidateKeys.length; index += 1) {
        const key = candidateKeys[index];
        if (inputKeys[index] !== key && !hasOwnProperty.call(inputRecord, key)) return false;
        const left = inputRecord[key];
        const right = candidateRecord[key];
        if (left === right && (left !== 0 || 1 / left === 1 / (right as number))) continue;
        if (!sameShallowValue(left, right)) return false;
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
