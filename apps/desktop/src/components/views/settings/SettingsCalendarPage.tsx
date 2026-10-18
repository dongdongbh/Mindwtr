import type { SystemCalendarPermissionStatus, SystemCalendarPushTarget } from '../../../lib/system-calendar';
import {
    EXTERNAL_CALENDAR_COLORS,
    hasExplicitExternalCalendarColor,
    themeExternalCalendarDisplayColor,
    type ExternalCalendarSubscription,
    updateSettingsFromLatest,
    useTaskStore,
} from '@mindwtr/core';
import { Ban, ExternalLink } from 'lucide-react';
import { getDocsGuideUrl } from '@mindwtr/core';
import { useDocumentationLanguage } from '../../../contexts/language-context';

import { cn } from '../../../lib/utils';
import { Switch } from '../../ui/Switch';

type Labels = {
    calendarIntegrationGuideTitle: string;
    calendar: string;
    calendarDesc: string;
    calendarName: string;
    calendarUrl: string;
    calendarAdd: string;
    calendarChooseLocalFile: string;
    calendarRemove: string;
    calendarColorAuto: string;
    calendarShowInAreas: string;
    calendarAllAreas: string;
    externalCalendars: string;
    calendarSystemTitle: string;
    calendarSystemDesc: string;
    calendarSystemStatus: string;
    calendarSystemPermissionGranted: string;
    calendarSystemPermissionUndetermined: string;
    calendarSystemPermissionDenied: string;
    calendarSystemPermissionUnsupported: string;
    calendarSystemRequestAccess: string;
    calendarSystemDeniedHint: string;
    calendarPushTitle: string;
    calendarPushDesc: string;
    calendarPushEnable: string;
    calendarPushTarget: string;
    calendarPushManagedTarget: string;
    calendarPushRefresh: string;
    calendarPushLoading: string;
    calendarPushTargetHint: string;
};

type SettingsCalendarPageProps = {
    t: Labels;
    newCalendarName: string;
    newCalendarUrl: string;
    calendarError: string | null;
    externalCalendars: ExternalCalendarSubscription[];
    showSystemCalendarSection: boolean;
    systemCalendarPermission: SystemCalendarPermissionStatus;
    calendarPushEnabled: boolean;
    calendarPushTargetCalendarId: string | null;
    calendarPushTargets: SystemCalendarPushTarget[];
    calendarPushLoading: boolean;
    /** Active theme, for the swatch fills only — picks stay canonical (#974). */
    theme?: string;
    onCalendarNameChange: (value: string) => void;
    onCalendarUrlChange: (value: string) => void;
    onAddCalendar: () => void;
    onChooseLocalCalendarFile?: () => Promise<void> | void;
    onToggleCalendar: (id: string, enabled: boolean) => void;
    onCalendarColorChange: (id: string, color: string | undefined) => void;
    onRemoveCalendar: (id: string) => void;
    onRequestSystemCalendarPermission: () => void;
    onToggleCalendarPush: (enabled: boolean) => Promise<void> | void;
    onCalendarPushTargetChange: (id: string | null) => Promise<void> | void;
    onRefreshCalendarPushTargets: () => Promise<void> | void;
    maskCalendarUrl: (url: string) => string;
};

export function SettingsCalendarPage({
    t,
    newCalendarName,
    newCalendarUrl,
    calendarError,
    externalCalendars,
    showSystemCalendarSection,
    systemCalendarPermission,
    calendarPushEnabled,
    calendarPushTargetCalendarId,
    calendarPushTargets,
    calendarPushLoading,
    theme,
    onCalendarNameChange,
    onCalendarUrlChange,
    onAddCalendar,
    onChooseLocalCalendarFile,
    onToggleCalendar,
    onCalendarColorChange,
    onRemoveCalendar,
    onRequestSystemCalendarPermission,
    onToggleCalendarPush,
    onCalendarPushTargetChange,
    onRefreshCalendarPushTargets,
    maskCalendarUrl,
}: SettingsCalendarPageProps) {
    const language = useDocumentationLanguage();
    const areas = useTaskStore((state) => state.areas).filter((area) => !area.deletedAt);
    // Toggles the area on the calendar as stored when the write is admitted, so another device's edits stay.
    const toggleArea = (calendar: ExternalCalendarSubscription, areaId: string) => {
        void updateSettingsFromLatest((latest) => ({
            externalCalendars: (latest.externalCalendars ?? externalCalendars).map((entry) => {
                if (entry.id !== calendar.id) return entry;
                const current = entry.areaIds ?? [];
                return { ...entry, areaIds: current.includes(areaId) ? current.filter((id) => id !== areaId) : [...current, areaId] };
            }),
        }));
    };
    const permissionLabel = (() => {
        if (systemCalendarPermission === 'granted') return t.calendarSystemPermissionGranted;
        if (systemCalendarPermission === 'undetermined') return t.calendarSystemPermissionUndetermined;
        if (systemCalendarPermission === 'denied') return t.calendarSystemPermissionDenied;
        return t.calendarSystemPermissionUnsupported;
    })();

    return (
        <div className="space-y-6">
            {showSystemCalendarSection && (
                <div className="bg-card border border-border rounded-lg p-6 space-y-4">
                    <div data-settings-key="calendarSystemTitle" className="space-y-1">
                        <div className="text-sm font-semibold">{t.calendarSystemTitle}</div>
                        <p className="text-sm text-muted-foreground">{t.calendarSystemDesc}</p>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="text-sm">
                            <span className="text-muted-foreground">{t.calendarSystemStatus}: </span>
                            <span className="font-medium">{permissionLabel}</span>
                        </div>
                        {(systemCalendarPermission === 'undetermined' || systemCalendarPermission === 'denied') && (
                            <button
                                type="button"
                                onClick={onRequestSystemCalendarPermission}
                                className="text-sm px-3 py-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                            >
                                {t.calendarSystemRequestAccess}
                            </button>
                        )}
                    </div>
                    {systemCalendarPermission === 'denied' && (
                        <p className="text-xs text-muted-foreground">{t.calendarSystemDeniedHint}</p>
                    )}
                    <div className="border-t border-border pt-4 space-y-3">
                        <div className="flex items-start justify-between gap-4">
                            <div data-settings-key="calendarPushTitle" className="space-y-1">
                                <div className="text-sm font-medium">{t.calendarPushTitle}</div>
                                <p className="text-xs text-muted-foreground">{t.calendarPushDesc}</p>
                            </div>
                            <Switch
                                aria-label={t.calendarPushTitle}
                                checked={calendarPushEnabled}
                                disabled={calendarPushLoading}
                                onCheckedChange={onToggleCalendarPush}
                            />
                        </div>

                        {calendarPushEnabled && systemCalendarPermission === 'granted' && (
                            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
                                <label data-settings-key="calendarPushTarget" className="space-y-1">
                                    <span className="text-sm font-medium">{t.calendarPushTarget}</span>
                                    <select
                                        value={calendarPushTargetCalendarId ?? ''}
                                        onChange={(event) => onCalendarPushTargetChange(event.target.value || null)}
                                        disabled={calendarPushLoading}
                                        className="w-full text-sm px-3 py-2 rounded border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30"
                                    >
                                        <option value="">{t.calendarPushManagedTarget}</option>
                                        {calendarPushTargets.map((target) => (
                                            <option key={target.id} value={target.id}>
                                                {target.sourceName ? `${target.name} (${target.sourceName})` : target.name}
                                            </option>
                                        ))}
                                    </select>
                                    <span className="block text-xs text-muted-foreground">{t.calendarPushTargetHint}</span>
                                </label>
                                <button
                                    type="button"
                                    onClick={onRefreshCalendarPushTargets}
                                    disabled={calendarPushLoading}
                                    className="text-sm px-3 py-2 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-60"
                                >
                                    {calendarPushLoading ? t.calendarPushLoading : t.calendarPushRefresh}
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            )}

            <div className="bg-card border border-border rounded-lg p-6 space-y-4">
                <div data-settings-key="calendar" className="space-y-1">
                    <div className="text-sm font-medium">{t.calendar}</div>
                    <p className="text-xs text-muted-foreground">{t.calendarDesc}</p>
                </div>
                <a
                    href={getDocsGuideUrl('use/calendar-integration', language)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                >
                    {t.calendarIntegrationGuideTitle}
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                </a>

                <div className="grid gap-3 md:grid-cols-2">
                    <div data-settings-key="calendarName" className="space-y-1">
                        <div className="text-sm font-medium">{t.calendarName}</div>
                        <input
                            value={newCalendarName}
                            aria-label={t.calendarName}
                            onChange={(e) => onCalendarNameChange(e.target.value)}
                            placeholder={t.calendarName}
                            className="w-full text-sm px-3 py-2 rounded border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30"
                        />
                    </div>
                    <div data-settings-key="calendarUrl" className="space-y-1">
                        <div className="text-sm font-medium">{t.calendarUrl}</div>
                        <input
                            value={newCalendarUrl}
                            aria-label={t.calendarUrl}
                            onChange={(e) => onCalendarUrlChange(e.target.value)}
                            placeholder="https://... or file:///..."
                            className="w-full text-sm px-3 py-2 rounded border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30"
                        />
                    </div>
                </div>

                <div data-settings-key="calendarChooseLocalFile" className="flex items-center justify-between gap-4">
                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            disabled={!newCalendarUrl.trim()}
                            onClick={onAddCalendar}
                            className={cn(
                                "text-sm px-3 py-2 rounded-md transition-colors",
                                newCalendarUrl.trim()
                                    ? "bg-primary text-primary-foreground hover:bg-primary/90"
                                    : "bg-muted text-muted-foreground cursor-not-allowed"
                            )}
                        >
                            {t.calendarAdd}
                        </button>
                        {onChooseLocalCalendarFile && (
                            <button
                                type="button"
                                onClick={onChooseLocalCalendarFile}
                                className="text-sm px-3 py-2 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                            >
                                {t.calendarChooseLocalFile}
                            </button>
                        )}
                    </div>
                    {calendarError && (
                        <div className="text-xs text-destructive">{calendarError}</div>
                    )}
                </div>
            </div>

            {externalCalendars.length > 0 && (
                <div className="bg-card border border-border rounded-lg overflow-hidden">
                    <div data-settings-key="externalCalendars" className="px-4 py-3 text-sm font-medium border-b border-border">{t.externalCalendars}</div>
                    <div className="divide-y divide-border">
                        {externalCalendars.map((calendar) => (
                            <div key={calendar.id} className="p-4 flex items-start justify-between gap-4">
                                <div className="min-w-0">
                                    <div className="text-sm font-medium truncate">{calendar.name}</div>
                                            <div className="text-xs text-muted-foreground truncate mt-1">{maskCalendarUrl(calendar.url)}</div>
                                            <div className="mt-2 flex flex-wrap gap-1.5" aria-label={`${calendar.name} color`}>
                                                {(() => {
                                                    const explicit = hasExplicitExternalCalendarColor(calendar.id, calendar.color);
                                                    return (
                                                        <>
                                                            <button
                                                                type="button"
                                                                aria-label={`${calendar.name} ${t.calendarColorAuto}`}
                                                                aria-pressed={!explicit}
                                                                title={t.calendarColorAuto}
                                                                onClick={() => onCalendarColorChange(calendar.id, undefined)}
                                                                className={cn(
                                                                    "flex h-5 w-5 items-center justify-center rounded-full border bg-card transition focus:outline-none focus:ring-2 focus:ring-primary/40",
                                                                    !explicit
                                                                        ? "border-background ring-2 ring-primary ring-offset-2 ring-offset-background"
                                                                        : "border-border hover:border-foreground/40"
                                                                )}
                                                            >
                                                                <Ban className="h-3 w-3 text-muted-foreground" />
                                                            </button>
                                                            {EXTERNAL_CALENDAR_COLORS.map((color) => {
                                                                const selected = explicit && calendar.color === color;
                                                                return (
                                                                    <button
                                                                        key={color}
                                                                        type="button"
                                                                        aria-label={`${calendar.name} ${color}`}
                                                                        aria-pressed={selected}
                                                                        onClick={() => onCalendarColorChange(calendar.id, color)}
                                                                        className={cn(
                                                                            "h-5 w-5 rounded-full border transition focus:outline-none focus:ring-2 focus:ring-primary/40",
                                                                            selected
                                                                                ? "border-background ring-2 ring-primary ring-offset-2 ring-offset-background"
                                                                                : "border-border hover:border-foreground/40"
                                                                        )}
                                                                        style={{ backgroundColor: themeExternalCalendarDisplayColor(color, theme) }}
                                                                    />
                                                                );
                                                            })}
                                                        </>
                                                    );
                                                })()}
                                            </div>
                                            {areas.length > 0 && (
                                                <details className="mt-3 text-xs">
                                                    <summary className="cursor-pointer">{t.calendarShowInAreas}: {(calendar.areaIds ?? []).length === 0 ? t.calendarAllAreas : areas.filter((area) => calendar.areaIds?.includes(area.id)).map((area) => area.name).join(', ') || t.calendarAllAreas}</summary>
                                                    <div className="mt-2 flex flex-wrap gap-2">
                                                        {areas.map((area) => <label key={area.id} className="flex items-center gap-1"><input type="checkbox" checked={calendar.areaIds?.includes(area.id) ?? false} onChange={() => toggleArea(calendar, area.id)} />{area.name}</label>)}
                                                    </div>
                                                </details>
                                            )}
                                </div>
                                <div className="flex items-center gap-3">
                                    <input
                                        type="checkbox"
                                        checked={calendar.enabled}
                                        onChange={(e) => onToggleCalendar(calendar.id, e.target.checked)}
                                        className="h-4 w-4 accent-blue-600"
                                    />
                                    <button
                                        onClick={() => onRemoveCalendar(calendar.id)}
                                        className="text-sm text-destructive hover:text-destructive/80"
                                    >
                                        {t.calendarRemove}
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
