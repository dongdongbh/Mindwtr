import { encode } from 'uqr';
import { SHARE_CARD_ICON_DATA_URI } from './share-card-icon';

export type ShareCardKind = 'review';
export type ShareCardStyle = 'reflection' | 'minimal' | 'ripple';

export type ShareCardInput = {
    kind: ShareCardKind;
    reviewDate?: string;
    reflection?: string;
    style?: ShareCardStyle;
};

export const SHARE_CARD_SIZE = 1080;
export const SHARE_CARD_REFLECTION_LIMIT = 140;
export const SHARE_CARD_DOWNLOAD_URL = 'https://mindwtr.app/get?ref=share';

type Translate = (key: string) => string;
type TextDirection = 'ltr' | 'rtl';

const REVIEW_COPY = {
    titleKey: 'shareCard.reviewTitle',
    title: 'Weekly review',
    bodyKey: 'shareCard.reviewBody',
    body: 'This week, I made space to think.',
};

const FONT_FAMILY = 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, &quot;Segoe UI&quot;, sans-serif';
const XML_UNSAFE_RE = /[&<>"']/g;
const XML_REPLACEMENTS: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
};
const BIDI_CONTROL_RE = /[\u202A-\u202E\u2066-\u2069]/g;
const COMBINING_MARK_RE = /\p{Mark}/u;
const RTL_RE = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFC]/u;
const WIDE_RE = /[\u1100-\u115F\u2329\u232A\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F000}-\u{1FAFF}]/u;

function stripInvalidXml(value: string): string {
    return Array.from(value).filter((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint === 9
            || codePoint === 10
            || codePoint === 13
            || (codePoint >= 32 && !(codePoint >= 0xD800 && codePoint <= 0xDFFF) && codePoint !== 0xFFFE && codePoint !== 0xFFFF);
    }).join('');
}

function escapeXml(value: string): string {
    return stripInvalidXml(value).replace(XML_UNSAFE_RE, (character) => XML_REPLACEMENTS[character]);
}

function cleanTitle(value: string): string {
    return stripInvalidXml(value)
        .replace(BIDI_CONTROL_RE, '')
        .replace(/\s+/gu, ' ')
        .trim();
}

function translated(t: Translate, key: string, fallback: string): string {
    const value = cleanTitle(t(key));
    return value && value !== key ? value : fallback;
}

function textDirection(value: string): TextDirection {
    return RTL_RE.test(value) ? 'rtl' : 'ltr';
}

function graphemes(value: string): string[] {
    const result: string[] = [];
    for (const character of Array.from(value)) {
        if (result.length > 0 && (COMBINING_MARK_RE.test(character) || character === '\uFE0F' || character === '\u200D')) {
            result[result.length - 1] += character;
            continue;
        }
        if (result.length > 0 && result[result.length - 1].endsWith('\u200D')) {
            result[result.length - 1] += character;
            continue;
        }
        result.push(character);
    }
    return result;
}

function characterWidth(character: string): number {
    if (WIDE_RE.test(character)) return 2;
    if (/^[MW@%]$/.test(character)) return 1.8;
    if (/^[mw]$/.test(character)) return 1.5;
    if (/^[ilI.,:;!|' ]$/.test(character)) return 0.55;
    return 1;
}

function displayWidth(value: string): number {
    return graphemes(value).reduce((width, character) => width + characterWidth(character), 0);
}

function takeByWidth(value: string, maxWidth: number): { head: string; tail: string } {
    const characters = graphemes(value);
    let width = 0;
    let index = 0;
    while (index < characters.length) {
        const nextWidth = characterWidth(characters[index]);
        if (width + nextWidth > maxWidth) break;
        width += nextWidth;
        index += 1;
    }
    return { head: characters.slice(0, index).join(''), tail: characters.slice(index).join('') };
}

function ellipsize(value: string, maxWidth: number): string {
    if (displayWidth(value) <= maxWidth) return value;
    return `${takeByWidth(value, Math.max(1, maxWidth - 1)).head.trimEnd()}…`;
}

function wrapText(value: string, maxWidth: number, maxLines: number): string[] {
    let remaining = cleanTitle(value);
    const lines: string[] = [];
    while (remaining && lines.length < maxLines) {
        if (lines.length === maxLines - 1) {
            lines.push(ellipsize(remaining, maxWidth));
            break;
        }
        const part = takeByWidth(remaining, maxWidth);
        if (!part.tail) { lines.push(part.head); break; }
        const lastSpace = part.head.lastIndexOf(' ');
        const atWordBoundary = lastSpace > part.head.length / 2;
        const line = atWordBoundary ? part.head.slice(0, lastSpace) : part.head;
        lines.push(line.trimEnd());
        remaining = remaining.slice(line.length).trimStart();
    }
    return lines.length ? lines : [''];
}

function renderTextLines(lines: readonly string[], x: number, y: number, lineHeight: number, attributes: string, rightEdge = 972, nativeText = false): string {
    return lines.map((line, index) => {
        const direction = textDirection(line);
        const anchor = direction === 'rtl' && nativeText ? 'end' : 'start';
        const lineX = direction === 'rtl' ? rightEdge : x;
        return `<text x="${lineX}" y="${y + index * lineHeight}" ${attributes} direction="${direction}" text-anchor="${anchor}" unicode-bidi="plaintext">${escapeXml(line)}</text>`;
    }).join('');
}

function renderQr(label: string): string {
    const qr = encode(SHARE_CARD_DOWNLOAD_URL, { border: 4, ecc: 'M', boostEcc: false });
    const moduleSize = 4;
    const path = qr.data.flatMap((row, rowIndex) => row.flatMap((dark, columnIndex) => (
        dark ? [`M${columnIndex * moduleSize},${rowIndex * moduleSize}h${moduleSize}v${moduleSize}h-${moduleSize}z`] : []
    ))).join('');
    const size = qr.size * moduleSize;
    const x = 836;
    const y = 804;
    return `<g data-share-card-qr="${SHARE_CARD_DOWNLOAD_URL}" data-qr-modules="${qr.size}" data-qr-module-size="${moduleSize}" transform="translate(${x} ${y})"><title>${escapeXml(label)}</title><rect width="${size}" height="${size}" rx="4" fill="#ffffff"/><path d="${path}" fill="#14365f"/></g>`;
}

/**
 * Local-only review artwork. Only the explicit date and optional note enter the
 * image; no task store or review statistics are read here.
 */
export function renderShareCardSvg(
    input: ShareCardInput,
    t: Translate,
    options: { textLayout?: 'svg' | 'native' } = {},
): string {
    // Native SVG text anchors are physical; browser SVG anchors follow direction.
    const renderLines = (lines: readonly string[], x: number, y: number, lineHeight: number, attributes: string, rightEdge = 972) =>
        renderTextLines(lines, x, y, lineHeight, attributes, rightEdge, options.textLayout === 'native');
    const title = `${translated(t, REVIEW_COPY.titleKey, REVIEW_COPY.title)} ✓`;
    const reflection = cleanTitle(Array.from(input.reflection ?? '').slice(0, SHARE_CARD_REFLECTION_LIMIT).join(''));
    const body = reflection || translated(t, REVIEW_COPY.bodyKey, REVIEW_COPY.body);
    const date = cleanTitle(Array.from(input.reviewDate ?? '').slice(0, 80).join(''));
    const style = input.style === 'ripple' || input.style === 'minimal' ? input.style : 'reflection';
    const dark = style === 'ripple';
    const ink = dark ? '#f3f8fd' : '#14365f';
    const muted = dark ? '#b8d4e9' : '#4c6a72';
    const paper = dark ? '#102e52' : '#f7fbfc';
    const bodyWidth = displayWidth(body);
    const fontSize = bodyWidth > 190 ? 36 : bodyWidth > 115 ? 44 : bodyWidth > 65 ? 56 : 64;
    const maxLines = bodyWidth > 190 ? 7 : bodyWidth > 115 ? 6 : 5;
    const bodyLines = wrapText(body, Math.floor(860 / (fontSize * 0.57)), maxLines);
    const dateLines = date ? wrapText(date, 54, 1) : [];
    const titleLines = wrapText(title, 34, 2);
    const qrLabel = translated(t, 'shareCard.qrLabel', 'Get Mindwtr');
    const tagline = translated(t, 'shareCard.tagline', 'Mind like water.');
    const text = (size: number, color: string, weight = 400) => `font-family="${FONT_FAMILY}" font-size="${size}" font-weight="${weight}" fill="${color}"`;
    const decoration = style === 'reflection'
        ? '<rect x="56" y="338" width="968" height="430" rx="28" fill="url(#reflection-glow)"/><path d="M-120 1040C140 806 362 830 618 1010S932 1132 1190 930" fill="none" stroke="#e4eff1" stroke-width="24"/>'
        : dark
            ? '<circle cx="1030" cy="166" r="440" fill="none" stroke="#235482" stroke-width="70"/><circle cx="1030" cy="166" r="310" fill="none" stroke="#1b456c" stroke-width="34"/><path d="M-100 1060C194 810 392 902 592 1048S934 1122 1180 934" fill="none" stroke="#235482" stroke-width="24"/>'
            : '<path d="M88 770H992" stroke="#d2e2e3" stroke-width="2"/>';
    const bodyY = 445;
    const bodyText = renderLines(bodyLines, 96, bodyY, fontSize + 10, text(fontSize, ink, style === 'minimal' ? 400 : 500));

    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${SHARE_CARD_SIZE}" height="${SHARE_CARD_SIZE}" viewBox="0 0 ${SHARE_CARD_SIZE} ${SHARE_CARD_SIZE}" role="img" aria-labelledby="share-card-title share-card-desc"><title id="share-card-title">${escapeXml(title)}</title><desc id="share-card-desc">${escapeXml([...dateLines, ...bodyLines].join(' '))}</desc><defs><linearGradient id="reflection-glow" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e0eafa"/><stop offset="1" stop-color="#edf5f4"/></linearGradient><clipPath id="card-clip"><rect width="1080" height="1080" rx="48"/></clipPath></defs><g clip-path="url(#card-clip)"><rect width="1080" height="1080" fill="${paper}"/>${decoration}<image x="88" y="72" width="72" height="72" xlink:href="${SHARE_CARD_ICON_DATA_URI}"/><text x="184" y="120" ${text(32, ink, 600)}>Mindwtr</text>${renderLines(dateLines, 88, 225, 34, text(26, muted))}${renderLines(titleLines, 88, 292, 48, text(44, ink, 600))}${bodyText}${renderLines(wrapText(tagline, 32, 2), 88, 876, 42, text(34, ink, 500), 720)}<text x="88" y="952" ${text(24, muted)}>mindwtr.app</text>${renderQr(qrLabel)}<text x="910" y="984" ${text(18, muted)} text-anchor="middle" direction="${textDirection(qrLabel)}">${escapeXml(ellipsize(qrLabel, 26))}</text></g></svg>`;
}
