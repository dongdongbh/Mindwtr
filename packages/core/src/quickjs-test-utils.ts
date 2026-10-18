// QuickJS (the native Android app's engine) refuses a call with more than 65535 arguments, so `list.push(...rows)` or
// `Math.max(...values)` throws a RangeError there for a large library while V8, JSC and the host tests pass it. Runs [work]
// with push and Math.max held to that limit.
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
