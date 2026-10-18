import { FlaskConical, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import {
    flushPendingSave,
    isSandboxMode,
    normalizeDateFormatSetting,
    normalizeTimeFormatSetting,
    normalizeWeekStartPreference,
    updateSettingsFromLatest,
    useTaskStore,
    type AppSettings,
    type TaskEditorPresentation,
} from '@mindwtr/core';
import { useLanguage } from '../../contexts/language-context';
import { logInfo } from '../../lib/app-log';
import { exitDesktopSandbox, resetDesktopSandbox } from '../../lib/sandbox-session';
import { Switch } from '../ui/Switch';
import { LIST_END_GAP } from './list/list-toolbar';
import { SettingRow, SettingsCard, SettingsSectionHeader } from './settings/SettingRow';

export function SandboxSettingsView() {
    const { t } = useLanguage();
    const settings = useTaskStore((state) => state.settings);
    const updateSettings = useTaskStore((state) => state.updateSettings);
    const [error, setError] = useState<string | null>(null);

    // A built update reads the settings as stored when its write is admitted, so a newer key stays (as on mobile).
    const save = async (updates: Partial<AppSettings> | ((latest: AppSettings) => Partial<AppSettings>), setting: string) => {
        if (!isSandboxMode()) return;
        setError(null);
        try {
            await updateSettingsFromLatest((latest) => (typeof updates === 'function' ? updates(latest) : updates), { write: updateSettings });
            await flushPendingSave();
            void logInfo('Sandbox setting applied', {
                scope: 'sandbox',
                force: true,
                extra: { releaseCheck: 'v1.3.3/sandbox-settings', setting, platform: 'desktop' },
            });
        } catch {
            setError(t('settings.feedback.saveFailed'));
        }
    };

    const saveAppearance = (appearance: Partial<NonNullable<AppSettings['appearance']>>, setting: string) => {
        void save({ appearance }, setting);
    };

    const selectClassName = 'min-h-9 w-44 max-w-full rounded-md border border-border bg-background px-2 text-sm';

    const run = (action: () => void) => {
        setError(null);
        try {
            action();
        } catch {
            setError(t('sandbox.switchFailed'));
        }
    };

    return (
        <div className="h-full overflow-y-auto">
            <div className={`mx-auto max-w-3xl space-y-6 px-4 pt-3 ${LIST_END_GAP}`} data-sandbox-settings>
                <header>
                    <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
                        <FlaskConical className="h-5 w-5 text-primary" aria-hidden="true" />
                        {t('sandbox.title')}
                    </h2>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('sandbox.description')}</p>
                </header>

                <section className="rounded-lg border border-border bg-card p-5">
                    <p className="text-sm text-foreground">{t('sandbox.notice')}</p>
                    <div className="mt-4 flex flex-wrap gap-2">
                        <button
                            type="button"
                            onClick={() => run(() => resetDesktopSandbox(settings))}
                            className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-muted"
                            data-sandbox-settings-reset
                        >
                            <RotateCcw className="h-4 w-4" aria-hidden="true" />
                            {t('sandbox.reset')}
                        </button>
                        <button
                            type="button"
                            onClick={() => run(() => exitDesktopSandbox())}
                            className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
                            data-sandbox-settings-exit
                        >
                            {t('sandbox.exit')}
                        </button>
                    </div>
                    {error ? <p className="mt-3 text-xs text-destructive" role="alert">{error}</p> : null}
                </section>
                <section className="space-y-3">
                    <SettingsSectionHeader>{t('settings.taskEditorLayout')}</SettingsSectionHeader>
                    <SettingsCard>
                        <SettingRow padded settingsKey={null} title={t('settings.taskEditorPresentation')} description={t('settings.taskEditorPresentationDesc')} className="flex-wrap">
                            <select
                                aria-label={t('settings.taskEditorPresentation')}
                                className={selectClassName}
                                value={settings.gtd?.taskEditor?.presentation === 'modal' ? 'modal' : 'inline'}
                                onChange={(event) => {
                                    const presentation = event.target.value as TaskEditorPresentation;
                                    void save((latest) => ({
                                        gtd: {
                                            ...(latest.gtd ?? {}),
                                            taskEditor: { ...(latest.gtd?.taskEditor ?? {}), presentation },
                                        },
                                    }), 'editor-opening');
                                }}
                            >
                                <option value="inline">{t('settings.taskEditorPresentationInline')}</option>
                                <option value="modal">{t('settings.taskEditorPresentationModal')}</option>
                            </select>
                        </SettingRow>
                    </SettingsCard>
                </section>
                <section className="space-y-3">
                    <SettingsSectionHeader>{t('settings.appearance')}</SettingsSectionHeader>
                    <SettingsCard>
                        <SettingRow padded settingsKey={null} title={t('settings.density')} description={t('settings.densityDesc')} className="flex-wrap">
                            <select
                                aria-label={t('settings.density')}
                                className={selectClassName}
                                value={settings.appearance?.density ?? 'comfortable'}
                                onChange={(event) => saveAppearance({ density: event.target.value as NonNullable<AppSettings['appearance']>['density'] }, 'density')}
                            >
                                <option value="comfortable">{t('settings.densityComfortable')}</option>
                                <option value="compact">{t('settings.densityCompact')}</option>
                                <option value="condensed">{t('settings.densityCondensed')}</option>
                            </select>
                        </SettingRow>
                        <SettingRow padded settingsKey={null} title={t('settings.textSize')} description={t('settings.textSizeDesc')} className="flex-wrap">
                            <select
                                aria-label={t('settings.textSize')}
                                className={selectClassName}
                                value={settings.appearance?.textSize ?? 'default'}
                                onChange={(event) => saveAppearance({ textSize: event.target.value as NonNullable<AppSettings['appearance']>['textSize'] }, 'text-size')}
                            >
                                <option value="small">{t('settings.textSizeSmall')}</option>
                                <option value="default">{t('settings.textSizeDefault')}</option>
                                <option value="large">{t('settings.textSizeLarge')}</option>
                                <option value="extra-large">{t('settings.textSizeExtraLarge')}</option>
                            </select>
                        </SettingRow>
                        <SettingRow padded settingsKey={null} title={t('settings.showTaskAge')} description={t('settings.showTaskAgeDesc')}>
                            <Switch
                                checked={settings.appearance?.showTaskAge === true}
                                aria-label={t('settings.showTaskAge')}
                                onCheckedChange={(value) => saveAppearance({ showTaskAge: value }, 'task-age')}
                            />
                        </SettingRow>
                    </SettingsCard>
                </section>
                <section className="space-y-3">
                    <SettingsSectionHeader>{t('settings.regionalFormats')}</SettingsSectionHeader>
                    <SettingsCard>
                        <SettingRow padded settingsKey={null} title={t('settings.weekStart')} className="flex-wrap">
                            <select
                                aria-label={t('settings.weekStart')}
                                className={selectClassName}
                                value={normalizeWeekStartPreference(settings.weekStart)}
                                onChange={(event) => void save({ weekStart: event.target.value as AppSettings['weekStart'] }, 'week-start')}
                            >
                                <option value="system">{t('settings.weekStartSystem')}</option>
                                <option value="monday">{t('settings.weekStartMonday')}</option>
                                <option value="sunday">{t('settings.weekStartSunday')}</option>
                                <option value="saturday">{t('settings.weekStartSaturday')}</option>
                            </select>
                        </SettingRow>
                        <SettingRow padded settingsKey={null} title={t('settings.dateFormat')} className="flex-wrap">
                            <select
                                aria-label={t('settings.dateFormat')}
                                className={selectClassName}
                                value={normalizeDateFormatSetting(settings.dateFormat)}
                                onChange={(event) => void save({ dateFormat: event.target.value }, 'date-format')}
                            >
                                <option value="system">{t('settings.dateFormatSystem')}</option>
                                <option value="dmy">{t('settings.dateFormatDmy')}</option>
                                <option value="mdy">{t('settings.dateFormatMdy')}</option>
                                <option value="ymd">{t('settings.dateFormatYmd')}</option>
                            </select>
                        </SettingRow>
                        <SettingRow padded settingsKey={null} title={t('settings.timeFormat')} className="flex-wrap">
                            <select
                                aria-label={t('settings.timeFormat')}
                                className={selectClassName}
                                value={normalizeTimeFormatSetting(settings.timeFormat)}
                                onChange={(event) => void save({ timeFormat: event.target.value }, 'time-format')}
                            >
                                <option value="system">{t('settings.timeFormatSystem')}</option>
                                <option value="12h">{t('settings.timeFormat12h')}</option>
                                <option value="24h">{t('settings.timeFormat24h')}</option>
                            </select>
                        </SettingRow>
                    </SettingsCard>
                </section>
            </div>
        </div>
    );
}
