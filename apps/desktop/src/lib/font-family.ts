import { isTauriRuntime } from './runtime';
import { invokeNativeOr } from './tauri-invoke';

export const FONT_FAMILY_STORAGE_KEY = 'mindwtr-font-family';
const MAX_FONT_FAMILY_LENGTH = 120;

const DEFAULT_FONT_STACK = 'ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"';


export function coerceDesktopFontFamily(value: unknown): string {
    if (typeof value !== 'string') return '';
    return value.replace(/[;{}<>"'\\\r\n]/g, '').trim().slice(0, MAX_FONT_FAMILY_LENGTH);
}

export function resolveDesktopFontStack(family: string): string {
    const name = coerceDesktopFontFamily(family);
    if (!name) return DEFAULT_FONT_STACK;
    return `"${name}", ${DEFAULT_FONT_STACK}`;
}

export function applyDesktopFontFamily(family: string): void {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const name = coerceDesktopFontFamily(family);
    if (!name) {
        root.style.removeProperty('--mindwtr-font-family');
        return;
    }
    root.style.setProperty('--mindwtr-font-family', resolveDesktopFontStack(name));
}


export type BoldFaceCheck = 'real' | 'synthesized' | 'fallback' | 'unknown';


const MISSING_FAMILY = 'MindwtrNoSuchFamily';
const BOLD_PROBE_TEXT = 'Handgloves quick brown fox';


export function checkBoldFace(family: string): BoldFaceCheck {
    const name = coerceDesktopFontFamily(family);
    if (!name || typeof document === 'undefined') return 'unknown';
    let measure: CanvasRenderingContext2D | null = null;
    try {
        measure = document.createElement('canvas').getContext('2d');
    } catch {
        return 'unknown';
    }
    if (!measure) return 'unknown';
    const width = (weight: number, on: string): number => {
        measure.font = `${weight} 40px "${on}"`;
        return measure.measureText(BOLD_PROBE_TEXT).width;
    };
    const missingRegular = width(400, MISSING_FAMILY);
    const missingBold = width(700, MISSING_FAMILY);
    const regular = width(400, name);
    const bold = width(700, name);
    if (!regular || !bold) return 'unknown';
    if (regular === missingRegular && bold === missingBold) return 'fallback';
    return regular === bold ? 'synthesized' : 'real';
}


export function canListInstalledFonts(): boolean {
    return isTauriRuntime();
}


export async function loadInstalledFontFamilies(): Promise<string[]> {
    if (!isTauriRuntime()) return [];
    const families = await invokeNativeOr<unknown>([], 'list_system_fonts');
    if (!Array.isArray(families)) return [];
    return families.map(coerceDesktopFontFamily).filter((family) => family.length > 0);
}
