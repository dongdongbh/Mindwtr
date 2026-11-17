import { renderShareCardSvg, SHARE_CARD_REFLECTION_LIMIT, type ShareCardStyle } from '../../../packages/core/src/share-card';

type Reply = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };
type Strings = { getStrings(input: { keys: string[] }): { ok: true; value: { language: string; strings: Record<string, string> } } | { ok: false } };

const STYLES: readonly ShareCardStyle[] = ['reflection', 'minimal', 'ripple'];
const STYLE_KEYS: Record<ShareCardStyle, string> = {
    reflection: 'shareCard.styleReflection', minimal: 'shareCard.styleMinimal', ripple: 'shareCard.styleRipple',
};
const LABELS = {
    title: 'shareCard.title', close: 'shareCard.close', preview: 'shareCard.preview', privacy: 'shareCard.privacy',
    styleLabel: 'shareCard.styleLabel', reflectionLabel: 'shareCard.reflectionLabel', reflectionPlaceholder: 'shareCard.reflectionPlaceholder',
    defaultHint: 'shareCard.defaultHint', share: 'shareCard.share', generating: 'shareCard.generating', error: 'shareCard.error',
    unavailable: 'shareCard.unavailable',
};
const CARD_KEYS = ['shareCard.reviewTitle', 'shareCard.reviewBody', 'shareCard.qrLabel', 'shareCard.tagline'];

const invalid = (message: string): Reply => ({ ok: false, error: { code: 'INVALID_INPUT', message } });


export function readShareCard(input: unknown, contract: Strings, now: Date = new Date()): Reply {
    if (typeof input !== 'object' || input === null) return invalid('A share card style, reflection and date are required');
    const read = input as { style?: unknown; reflection?: unknown; reviewDate?: unknown };
    const style = read.style ?? 'reflection';
    const reflection = read.reflection ?? '';
    if (!STYLES.includes(style as ShareCardStyle)) return invalid('Unknown share card style');
    if (typeof reflection !== 'string' || reflection.length > SHARE_CARD_REFLECTION_LIMIT * 4) return invalid('The reflection must be text within the limit');
    if (read.reviewDate !== undefined && (typeof read.reviewDate !== 'string' || read.reviewDate.length > 200)) return invalid('The review date must be text');
    const keys = [...Object.values(LABELS), ...Object.values(STYLE_KEYS), ...CARD_KEYS];
    const strings = contract.getStrings({ keys });
    if (!strings.ok) return invalid('Strings are unavailable');
    const t = (key: string) => strings.value.strings[key] ?? key;
    const reviewDate = (read.reviewDate as string | undefined)
        ?? now.toLocaleDateString(strings.value.language, { year: 'numeric', month: 'long', day: 'numeric' });
    const limited = Array.from(reflection).slice(0, SHARE_CARD_REFLECTION_LIMIT).join('');
    return {
        ok: true,
        value: {
            svg: renderShareCardSvg({ kind: 'review', style: style as ShareCardStyle, reviewDate, reflection: limited || undefined }, t, { textLayout: 'native' }),
            style,
            reflection: limited,
            reviewDate,
            limit: SHARE_CARD_REFLECTION_LIMIT,
            styles: STYLES.map((id) => ({ id, label: t(STYLE_KEYS[id]) })),
            labels: Object.fromEntries(Object.entries(LABELS).map(([name, key]) => [name, t(key)])),
        },
    };
}
