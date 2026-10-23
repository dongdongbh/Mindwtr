export const record = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
export const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
    Object.keys(value).length === keys.length && keys.every((key) => own(value, key));

/** The host checks UTF-8 bytes, including for a JSON string with non-ASCII text. */
export const isNativeJsonWithinBytes = (value: unknown, limit = 2_000_000): boolean => {
    let json: string;
    try {
        json = JSON.stringify(value);
    } catch {
        return false;
    }
    if (typeof json !== 'string' || json.length > limit) return false;
    let bytes = 0;
    for (let index = 0; index < json.length; index++) {
        const unit = json.charCodeAt(index);
        if (unit < 0x80) bytes++;
        else if (unit < 0x800) bytes += 2;
        else if (unit >= 0xd800 && unit <= 0xdbff
            && index + 1 < json.length && json.charCodeAt(index + 1) >= 0xdc00
            && json.charCodeAt(index + 1) <= 0xdfff) {
            bytes += 4;
            index++;
        } else bytes += 3;
        if (bytes > limit) return false;
    }
    return true;
};
