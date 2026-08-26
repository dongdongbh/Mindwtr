import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { AREA_PRESET_COLORS, DEFAULT_AREA_COLOR } from '@mindwtr/core';
import { Ban, Check } from 'lucide-react';
import { Button } from '../../ui/Button';

type AreaColorPickerProps = {
    value?: string;
    onChange: (color: string | undefined) => void;
    title: string;
    align?: 'left' | 'right';
    /** Label for the "no color" option. Defaults to "None". */
    noneLabel?: string;
    /** Label for the free-form color option. Defaults to "Custom color". */
    customLabel?: string;
    /** Label for the button that commits the custom color. Defaults to "OK". */
    applyLabel?: string;
    /** Label for the button that discards the custom color. Defaults to "Cancel". */
    cancelLabel?: string;
};

const CUSTOM_SWATCH_GRADIENT =
    'conic-gradient(#ef4444, #f59e0b, #10b981, #06b6d4, #3b82f6, #8b5cf6, #ec4899, #ef4444)';

const HUE_TRACK_GRADIENT =
    'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)';

const HEX_PATTERN = /^#[0-9a-f]{6}$/;

/** The only shape allowed out of this component: 8-digit hex breaks Android widgets. */
const normalizeHex = (input: string): string | null => {
    const candidate = input.trim().toLowerCase().replace(/^#?/, '#');
    return HEX_PATTERN.test(candidate) ? candidate : null;
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

type Hsv = { h: number; s: number; v: number };

const toHexPair = (value: number) =>
    Math.round(clamp01(value) * 255)
        .toString(16)
        .padStart(2, '0');

const hsvToHex = ({ h, s, v }: Hsv) => {
    const channel = (n: number) => {
        const k = (n + h / 60) % 6;
        return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    };
    return `#${toHexPair(channel(5))}${toHexPair(channel(3))}${toHexPair(channel(1))}`;
};

const hexToHsv = (hex: string): Hsv => {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b);
    const delta = max - Math.min(r, g, b);
    const sector =
        delta === 0
            ? 0
            : max === r
              ? ((g - b) / delta + 6) % 6
              : max === g
                ? (b - r) / delta + 2
                : (r - g) / delta + 4;
    return { h: sector * 60, s: max === 0 ? 0 : delta / max, v: max };
};

/**
 * Drag on a track, same window-listener idiom as the projects sidebar resizer.
 * Reports the pointer position as a 0..1 fraction of the element it started on.
 */
const trackDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    update: (x: number, y: number) => void,
) => {
    if (event.button !== 0) return;
    event.preventDefault();

    const rect = event.currentTarget.getBoundingClientRect();
    const emit = (clientX: number, clientY: number) => {
        update(
            rect.width ? clamp01((clientX - rect.left) / rect.width) : 0,
            rect.height ? clamp01((clientY - rect.top) / rect.height) : 0,
        );
    };

    const handleMove = (moveEvent: PointerEvent) => emit(moveEvent.clientX, moveEvent.clientY);
    const handleUp = () => {
        window.removeEventListener('pointermove', handleMove);
        window.removeEventListener('pointerup', handleUp);
        window.removeEventListener('pointercancel', handleUp);
    };

    emit(event.clientX, event.clientY);
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
};

type CustomColorPanelProps = {
    /** Seeds the panel. It remounts on every open, so this is always current. */
    initial: string;
    hexLabel: string;
    applyLabel: string;
    cancelLabel: string;
    onApply: (color: string) => void;
    onCancel: () => void;
};

function CustomColorPanel({
    initial,
    hexLabel,
    applyLabel,
    cancelLabel,
    onApply,
    onCancel,
}: CustomColorPanelProps) {
    const [hsv, setHsv] = useState(() => hexToHsv(initial));
    const [hexText, setHexText] = useState(initial);

    // Typed text wins over the round-tripped HSV so an exact hex stays exact.
    const committableHex = normalizeHex(hexText);
    const previewHex = committableHex ?? hsvToHex(hsv);

    const moveTo = (next: Hsv) => {
        setHsv(next);
        setHexText(hsvToHex(next));
    };

    const editHex = (text: string) => {
        setHexText(text);
        const parsed = normalizeHex(text);
        if (parsed) setHsv(hexToHsv(parsed));
    };

    return (
        <div className="col-span-7 flex flex-col gap-2 pt-1" data-testid="area-color-picker-panel">
            <div
                // Pointer affordances only; the hex field below is the keyboard
                // and screen-reader path to the same value.
                aria-hidden="true"
                className="relative h-24 w-full cursor-crosshair rounded-md border border-border"
                style={{
                    background: `linear-gradient(to top, #000, rgba(0, 0, 0, 0)), linear-gradient(to right, #fff, rgba(255, 255, 255, 0)), hsl(${hsv.h}, 100%, 50%)`,
                }}
                onPointerDown={(event) =>
                    trackDrag(event, (x, y) => moveTo({ h: hsv.h, s: x, v: 1 - y }))
                }
                data-testid="area-color-picker-surface"
            >
                <span
                    className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
                    style={{
                        left: `${hsv.s * 100}%`,
                        top: `${(1 - hsv.v) * 100}%`,
                        backgroundColor: previewHex,
                    }}
                />
            </div>
            <div
                aria-hidden="true"
                className="relative h-3 w-full cursor-ew-resize rounded-full border border-border"
                style={{ background: HUE_TRACK_GRADIENT }}
                onPointerDown={(event) =>
                    trackDrag(event, (x) => moveTo({ ...hsv, h: x * 360 }))
                }
                data-testid="area-color-picker-hue"
            >
                <span
                    className="pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
                    style={{ left: `${(hsv.h / 360) * 100}%`, backgroundColor: `hsl(${hsv.h}, 100%, 50%)` }}
                />
            </div>
            <div className="flex items-center gap-2">
                <span
                    className="h-7 w-7 shrink-0 rounded-full border border-border"
                    style={{ backgroundColor: previewHex }}
                    data-testid="area-color-picker-preview"
                />
                <input
                    value={hexText}
                    onChange={(event) => editHex(event.target.value)}
                    aria-label={hexLabel}
                    aria-invalid={committableHex ? undefined : true}
                    spellCheck={false}
                    maxLength={7}
                    className={`h-7 w-0 min-w-0 flex-1 rounded-md border bg-card px-2 font-mono text-xs text-foreground ${
                        committableHex ? 'border-border' : 'border-destructive'
                    }`}
                />
            </div>
            <div className="flex justify-end gap-2">
                <Button variant="ghost" size="xs" onClick={onCancel}>
                    {cancelLabel}
                </Button>
                <Button
                    size="xs"
                    disabled={!committableHex}
                    onClick={() => {
                        if (committableHex) onApply(committableHex);
                    }}
                >
                    {applyLabel}
                </Button>
            </div>
        </div>
    );
}

export function AreaColorPicker({
    value,
    onChange,
    title,
    align = 'left',
    noneLabel = 'None',
    customLabel = 'Custom color',
    applyLabel = 'OK',
    cancelLabel = 'Cancel',
}: AreaColorPickerProps) {
    const [open, setOpen] = useState(false);
    const [panelOpen, setPanelOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const resolvedValue = value || DEFAULT_AREA_COLOR;
    const customSelected =
        Boolean(value) && !(AREA_PRESET_COLORS as readonly string[]).includes(resolvedValue);

    const close = () => {
        setOpen(false);
        setPanelOpen(false);
    };

    useEffect(() => {
        if (!open) return;

        const handleMouseDown = (event: MouseEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) {
                close();
            }
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                close();
            }
        };

        window.addEventListener('mousedown', handleMouseDown);
        window.addEventListener('keydown', handleKeyDown);
        return () => {
            window.removeEventListener('mousedown', handleMouseDown);
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [open]);

    return (
        <div
            ref={rootRef}
            className={`relative shrink-0 ${open ? 'z-50' : ''}`}
            data-testid="area-color-picker-root"
        >
            <button
                type="button"
                onClick={() => (open ? close() : setOpen(true))}
                className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-card"
                title={title}
                aria-label={title}
                aria-expanded={open}
            >
                <span
                    className="h-4 w-4 rounded-full border border-black/10"
                    style={{ backgroundColor: resolvedValue }}
                />
            </button>
            {open ? (
                <div
                    // Seven columns keeps the popover exactly as wide as it was
                    // when the palette was one row of None + six swatches, so
                    // neither alignment can push it off-screen.
                    className={`absolute z-50 mt-2 grid w-max grid-cols-7 gap-2 rounded-lg border border-border bg-popover p-2 shadow-lg ${
                        align === 'right' ? 'right-0' : 'left-0'
                    }`}
                    data-testid="area-color-picker-menu"
                >
                    <button
                        type="button"
                        onClick={() => {
                            if (value) onChange(undefined);
                            close();
                        }}
                        className={`flex h-8 w-8 items-center justify-center rounded-full border bg-card ${
                            !value ? 'border-foreground' : 'border-border'
                        }`}
                        title={noneLabel}
                        aria-label={noneLabel}
                    >
                        <Ban className="h-3.5 w-3.5 text-muted-foreground" />
                    </button>
                    {AREA_PRESET_COLORS.map((color) => {
                        const selected = resolvedValue === color;
                        return (
                            <button
                                key={color}
                                type="button"
                                onClick={() => {
                                    if (color !== resolvedValue) {
                                        onChange(color);
                                    }
                                    close();
                                }}
                                className={`flex h-8 w-8 items-center justify-center rounded-full border ${
                                    selected ? 'border-foreground' : 'border-border'
                                }`}
                                style={{ backgroundColor: color }}
                                title={`${title}: ${color}`}
                                aria-label={`${title}: ${color}`}
                            >
                                {selected ? <Check className="h-3.5 w-3.5 text-white drop-shadow-sm" /> : null}
                            </button>
                        );
                    })}
                    <button
                        type="button"
                        onClick={() => setPanelOpen((current) => !current)}
                        className={`flex h-8 w-8 items-center justify-center rounded-full border ${
                            customSelected ? 'border-foreground' : 'border-border'
                        }`}
                        style={{ background: customSelected ? resolvedValue : CUSTOM_SWATCH_GRADIENT }}
                        title={customLabel}
                        aria-label={customLabel}
                        aria-expanded={panelOpen}
                        data-testid="area-color-picker-custom"
                    />
                    {panelOpen ? (
                        <CustomColorPanel
                            initial={resolvedValue}
                            // Distinct from the swatch's own label: two controls
                            // named "Custom color" would be ambiguous to AT.
                            hexLabel={`${title}: ${customLabel}`}
                            applyLabel={applyLabel}
                            cancelLabel={cancelLabel}
                            onApply={(color) => {
                                // Compared against `value`, not the resolved
                                // default: picking the fallback grey on an
                                // uncolored area is still a real choice.
                                if (color !== value) onChange(color);
                                close();
                            }}
                            onCancel={() => setPanelOpen(false)}
                        />
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}
