import { describe, expect, test } from 'vitest';
import {
    renderShareCardSvg,
    SHARE_CARD_DOWNLOAD_URL,
    SHARE_CARD_SIZE,
    SHARE_CARD_REFLECTION_LIMIT,
} from './share-card';

const translations: Record<string, string> = {
    'shareCard.reviewTitle': 'Weekly review',
    'shareCard.reviewBody': 'A little space to think.',
    'shareCard.qrLabel': 'Download Mindwtr',
};
const t = (key: string) => translations[key] ?? key;

describe('renderShareCardSvg', () => {
    test('renders the review card deterministically without any item data surface', () => {
        const input = { kind: 'review' as const };
        const first = renderShareCardSvg(input, t);

        expect(first).toBe(renderShareCardSvg(input, t));
        expect(first).toContain(`width="${SHARE_CARD_SIZE}" height="${SHARE_CARD_SIZE}"`);
        expect(first).toContain('Weekly review');
        expect(first).toContain('A little space to think.');
        expect(first).toContain('xlink:href="data:image/png;base64,');
        expect(first).not.toContain('<style>');
        expect(first).not.toContain('class=');
    });

    test('escapes translated text and removes unsafe controls', () => {
        const unsafe = (key: string) => key === 'shareCard.reviewBody'
            ? '<script> & "quoted"\u0000\u202E'
            : t(key);
        const svg = renderShareCardSvg({ kind: 'review' }, unsafe);

        expect(svg).toContain('&lt;script&gt; &amp; &quot;quoted&quot;');
        expect(svg).not.toContain('<script>');
        expect(svg).not.toContain('\u0000');
        expect(svg).not.toContain('\u202E');
    });

    test('encodes the fixed download URL by default with a four-module quiet zone', () => {
        const svg = renderShareCardSvg({ kind: 'review' }, t);
        const group = svg.match(/data-share-card-qr="([^"]+)" data-qr-modules="(\d+)" data-qr-module-size="(\d+)"/);
        const path = svg.match(/data-qr-module-size="\d+"[^>]*><title>[^<]+<\/title><rect[^>]*\/><path d="([^"]+)" fill="#14365f"/);

        expect(group?.[1]).toBe(SHARE_CARD_DOWNLOAD_URL);
        expect(group?.[2]).toBe('37');
        expect(group?.[3]).toBe('4');
        expect(path?.[1]).toContain('M16,16h4v4h-4z');
        expect(path?.[1]).not.toMatch(/M(?:0|4|8|12),|M\d+,(?:0|4|8|12)h/);
    });

    test('includes the date and explicit reflection, escaping it and bounding its length', () => {
        const svg = renderShareCardSvg({ kind: 'review', reviewDate: 'September 12, 2026', reflection: 'Make room for <family> & rest.' }, t);
        expect(svg).toContain('September 12, 2026');
        expect(svg).toContain('Make room for &lt;family&gt; &amp; rest.');
        expect(svg).not.toContain('A little space to think.');
        expect(svg).toContain(SHARE_CARD_DOWNLOAD_URL);
        const long = renderShareCardSvg({ kind: 'review', reflection: 'a'.repeat(SHARE_CARD_REFLECTION_LIMIT) + 'PRIVATE SUFFIX' }, t);
        expect(long).not.toContain('PRIVATE SUFFIX');
    });

    test('removes isolated surrogate characters and does not expose truncated reflection in metadata', () => {
        const svg = renderShareCardSvg({ kind: 'review', reflection: 'Hello\uD800 <script>' }, t);
        expect(svg).not.toContain('\uD800');
        expect(svg).not.toContain('<script>');
        expect(svg).toContain('&lt;script&gt;');
    });

    test.each(['reflection', 'minimal', 'ripple'] as const)('renders %s with a mandatory QR and personal note', (style) => {
        const svg = renderShareCardSvg({ kind: 'review', style, reflection: 'A slower week.', reviewDate: 'September 12, 2026' }, t);
        expect(svg).toContain(SHARE_CARD_DOWNLOAD_URL);
        expect(svg).toContain('A slower week.');
        expect(svg).toContain('September 12, 2026');
        expect(svg).toContain('data:image/png;base64,');
    });

    test('uses physical right anchors for native RTL text', () => {
        const svg = renderShareCardSvg({ kind: 'review', reflection: 'وقت للتفكير' }, t, { textLayout: 'native' });
        expect(svg).toMatch(/<text x="972"[^>]*direction="rtl" text-anchor="end"/);
    });

    test('keeps RTL footer text beside the QR', () => {
        const svg = renderShareCardSvg({ kind: 'review' }, (key) => key === 'shareCard.tagline' ? 'عقل كالماء.' : t(key));
        expect(svg).toMatch(/<text x="720" y="876"[^>]*direction="rtl" text-anchor="start"/);
        expect(svg).toMatch(/<text x="910" y="984"[^>]*text-anchor="middle"/);
    });

    test('wraps long CJK and RTL translations safely', () => {
        const unicode = (key: string) => {
            if (key === 'shareCard.reviewTitle') return '每周回顾与安静思考的时间';
            if (key === 'shareCard.reviewBody') return 'مساحة هادئة للتفكير فيما يهم الآن وما يمكن أن ينتظر قليلًا';
            return t(key);
        };
        const svg = renderShareCardSvg({ kind: 'review' }, unicode);

        expect(svg).toContain('每周回顾与安静思考');
        expect(svg).toContain('direction="rtl" text-anchor="start"');
        expect(svg).toContain('مساحة هادئة');
    });
});
