import type { NativeHostResult } from './native-host-contract';
import { record, detach } from './native-host-contract-project-shared';
import { useTaskStore } from './store';

export const SOMEDAY_SECTION_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;


export const SOMEDAY_SECTION_REQUEST_BYTES = 1_000_000;
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const unsupported = (message: string): NativeHostResult<never> => ({ ok: false, error: { code: 'INVALID_INPUT', message } });

export const hasUnpairedSurrogate = (value: string): boolean => {
    for (let index = 0; index < value.length; index++) {
        const unit = value.charCodeAt(index);
        if (unit >= 0xd800 && unit <= 0xdbff) {
            if (index + 1 >= value.length || value.charCodeAt(++index) < 0xdc00 || value.charCodeAt(index) > 0xdfff) return true;
        } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
    }
    return false;
};

export const validSomedaySectionTitle = (value: unknown): value is string =>
    typeof value === 'string' && Boolean(value.trim()) && value.length <= 200
    && !value.includes('\0') && !hasUnpairedSurrogate(value);

export const rawSomedaySections = (): NativeHostResult<unknown[] | null> => {
    const gtd = useTaskStore.getState().settings.gtd;
    if (gtd === undefined) return { ok: true, value: null };
    if (!record(gtd)) return unsupported('Stored Someday sections have an unsupported value');
    if (!own(gtd, 'viewSections')) return { ok: true, value: null };
    if (!record(gtd.viewSections)) return unsupported('Stored Someday sections have an unsupported value');
    if (!own(gtd.viewSections, 'someday')) return { ok: true, value: null };
    const sections = gtd.viewSections.someday;
    if (!Array.isArray(sections) || !detach(sections)) return unsupported('Stored Someday sections have an unsupported value');
    return { ok: true, value: sections };
};

export const rawSomedayStamp = (): NativeHostResult<string | null> => {
    const stamps = useTaskStore.getState().settings.syncPreferencesUpdatedAt;
    if (stamps === undefined) return { ok: true, value: null };
    if (!record(stamps)) return unsupported('Stored GTD timestamp has an unsupported value');
    if (!own(stamps, 'gtd')) return { ok: true, value: null };
    return typeof stamps.gtd === 'string' ? { ok: true, value: stamps.gtd }
        : unsupported('Stored GTD timestamp has an unsupported value');
};
