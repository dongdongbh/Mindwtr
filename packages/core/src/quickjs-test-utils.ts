


export const QUICKJS_MAX_CALL_ARGUMENTS = 65_535;

const refuse = (count: number): void => {
    if (count > QUICKJS_MAX_CALL_ARGUMENTS) {
        throw new RangeError(`too many arguments in function call (only ${QUICKJS_MAX_CALL_ARGUMENTS} allowed)`);
    }
};

export const withQuickJsArgumentLimit = <T>(work: () => T): T => {
    const push = Array.prototype.push;
    const max = Math.max;
    Array.prototype.push = function limitedPush(this: unknown[], ...items: unknown[]) {
        refuse(items.length);
        return push.apply(this, items);
    };
    Math.max = (...values: number[]) => {
        refuse(values.length);
        return max(...values);
    };
    try {
        return work();
    } finally {
        Array.prototype.push = push;
        Math.max = max;
    }
};
