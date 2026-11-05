


export const TRAY_TOOLTIP_MAX_LENGTH = 127;


const MIN_TITLE_CHARS = 8;
const ELLIPSIS = '…';

type BuildTrayTooltipOptions = {
    appName: string;
    focusLabel: string;
    titles: readonly string[];
};

const collapseWhitespace = (value: string): string => value.replace(/\s+/gu, ' ').trim();


export function buildTrayTooltip({ appName, focusLabel, titles }: BuildTrayTooltipOptions): string {
    const cleanTitles = titles.map(collapseWhitespace).filter((title) => title.length > 0);
    if (cleanTitles.length === 0) return appName;

    const heading = `${appName} — ${focusLabel} (${cleanTitles.length})`;


    if (heading.length > TRAY_TOOLTIP_MAX_LENGTH) {
        return heading.slice(0, TRAY_TOOLTIP_MAX_LENGTH - 1) + ELLIPSIS;
    }

    let tooltip = heading;
    let listed = 0;
    for (const title of cleanTitles) {


        const isLast = listed === cleanTitles.length - 1;
        const reserve = isLast ? 0 : `\n${ELLIPSIS}`.length;
        const line = `\n• ${title}`;
        if (tooltip.length + line.length + reserve <= TRAY_TOOLTIP_MAX_LENGTH) {
            tooltip += line;
            listed += 1;
            continue;
        }
        const room = TRAY_TOOLTIP_MAX_LENGTH - reserve - tooltip.length - '\n• '.length - 1;
        if (room >= MIN_TITLE_CHARS) {
            tooltip += `\n• ${title.slice(0, room)}${ELLIPSIS}`;
            listed += 1;
        }
        break;
    }

    if (listed < cleanTitles.length) tooltip += `\n${ELLIPSIS}`;
    return tooltip;
}
