import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createNativeHostContract } from '../../../packages/core/src/native-host-contract';
import { renderShareCardSvg } from '../../../packages/core/src/share-card';
import { en } from '../../../packages/core/src/i18n/locales/en';
import { readShareCard } from './host-share-card';

const entry = readFileSync(new URL('./host-entry.ts', import.meta.url), 'utf8');
const start = entry.indexOf('const MENU_READS: ');
const reads = entry.slice(start, entry.indexOf('\n};', start) + 3);
const englishStrings = {
    getStrings: ({ keys }: { keys: string[] }) => ({ ok: true as const, value: { language: 'en', strings: Object.fromEntries(keys.map((key) => [key, (en as Record<string, string>)[key]])) } }),
};
const at = new Date(2026, 10, 16, 9, 30);
type Card = { svg: string; style: string; reflection: string; reviewDate: string; limit: number; styles: { id: string; label: string }[]; labels: Record<string, string> };
const card = (reply: ReturnType<typeof readShareCard>) => {
    if (!reply.ok) throw new Error(reply.error.message);
    return reply.value as Card;
};

describe('the Weekly Review share card read', () => {
    it('renders core\'s SVG the way RN\'s share card modal asks for it, with RN\'s date and labels', () => {
        const read = card(readShareCard({}, englishStrings, at));
        expect(read.reviewDate).toBe('November 16, 2026');
        expect(read.style).toBe('reflection');
        expect(read.limit).toBe(140);
        expect(read.svg).toBe(renderShareCardSvg({ kind: 'review', style: 'reflection', reviewDate: 'November 16, 2026' },
            (key) => (en as Record<string, string>)[key] ?? key, { textLayout: 'native' }));
        expect(read.styles).toEqual([{ id: 'reflection', label: 'Reflection' }, { id: 'minimal', label: 'Minimal' }, { id: 'ripple', label: 'Ripple' }]);
        expect(read.labels).toMatchObject({ title: 'My weekly reflection', share: 'Share', privacy: en['shareCard.privacy'], close: 'Close' });
    });

    it('keeps the opened date, applies the chosen style and limits the reflection to 140 characters', () => {
        const long = 'é'.repeat(150);
        const read = card(readShareCard({ style: 'ripple', reflection: long, reviewDate: 'November 1, 2026' }, englishStrings, at));
        expect(read.reviewDate).toBe('November 1, 2026');
        expect(Array.from(read.reflection)).toHaveLength(140);
        expect(read.svg).toContain('fill="#102e52"');
        expect(read.svg).toContain('November 1, 2026');
        expect(read.svg).not.toContain('This week, I made space to think.');
    });

    it('draws only the SVG elements the Kotlin renderer (ShareCardSvg.kt) reads', () => {
        const drawn = new Set(['svg', 'title', 'desc', 'defs', 'linearGradient', 'stop', 'clipPath', 'g', 'rect', 'circle', 'path', 'image', 'text']);
        for (const style of ['reflection', 'minimal', 'ripple']) {
            for (const reflection of ['', 'שלום עולם and a long reflection that wraps over several lines of the card body text']) {
                const { svg } = card(readShareCard({ style, reflection }, englishStrings, at));
                const tags = new Set([...svg.matchAll(/<([a-zA-Z]+)[\s>/]/g)].map((match) => match[1]));
                expect([...tags].filter((tag) => !drawn.has(tag))).toEqual([]);
                expect(svg).not.toMatch(/transform="(?!translate\()/);
                expect(svg).not.toMatch(/fill="(?!#[0-9a-f]{6}"|none"|url\(#)/i);
            }
        }
    });

    it('refuses an unknown style or a non-text reflection', () => {
        for (const input of [null, 'reflection', { style: 'neon' }, { reflection: 3 }, { reviewDate: 5 }, { reflection: 'x'.repeat(561) }]) {
            expect(readShareCard(input, englishStrings, at)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
    });

    it('is the shareCard menu read in host-entry, with core\'s strings in the chosen language', async () => {
        const contract = createNativeHostContract();
        expect(await contract.setLanguage({ storedLanguage: 'de', systemLocale: 'de-DE' })).toMatchObject({ ok: true });
        const context: { contract: typeof contract; readShareCard: typeof readShareCard; withCalendar: (input: unknown) => unknown; MENU_READS?: Record<string, (input: unknown) => unknown> } =
            { contract, readShareCard, withCalendar: (input) => input };
        vm.runInNewContext(`${new Bun.Transpiler({ loader: 'ts' }).transformSync(reads)}\nglobalThis.MENU_READS = MENU_READS;`, context);
        const read = card(context.MENU_READS!.shareCard({ style: 'minimal', reviewDate: '16. November 2026' }) as ReturnType<typeof readShareCard>);
        const german = contract.getStrings({ keys: ['shareCard.share', 'shareCard.title'] });
        if (!german.ok) throw new Error('German strings unavailable');
        expect(read.labels.share).toBe(german.value.strings['shareCard.share']);
        expect(read.labels.title).toBe(german.value.strings['shareCard.title']);
        expect(read.labels.title).not.toBe('My weekly reflection');
        expect(read.svg).toContain('16. November 2026');
        const rows = { deferIds: ['a'], reviewIds: ['b'] };
        expect(context.MENU_READS!.focusRowMenus(rows)).toEqual(contract.getFocusRowMenus(rows));
    });
});
