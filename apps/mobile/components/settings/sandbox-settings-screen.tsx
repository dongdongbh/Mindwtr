import React from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { RotateCcw, X } from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
    updateSettingsFromLatest,
    DEFAULT_TASK_EDITOR_ORDER,
    DEFAULT_TASK_EDITOR_HIDDEN,
    flushPendingSave,
    isSandboxMode,
    normalizeDateFormatSetting,
    normalizeTimeFormatSetting,
    normalizeWeekStartPreference,
    resolveFeatureFlags,
    useTaskStore,
    type AppSettings,
    type TaskEditorFieldId,
} from '@mindwtr/core';

import { useThemeColors } from '@/hooks/use-theme-colors';
import { logInfo } from '@/lib/app-log';
import { buildTaskEditorPresetConfig, resolveTaskEditorPresetId, type TaskEditorPresetId } from '@/components/task-edit/task-edit-modal.utils';
import { SettingToggleRow } from './setting-row';
import { useSettingsLocalization, useSettingsScrollContent } from './settings.hooks';
import { SettingsTopBar } from './settings.shell';
import { styles as settingsStyles } from './settings.styles';
import { reloadIntoMobileSandbox, reloadIntoPersonalWorkspace } from '@/lib/sandbox-workspace';

type ChoiceOption = { value: string; label: string };

function ChoiceRow({
    label,
    value,
    options,
    onSelect,
    disabled,
}: {
    label: string;
    value: string;
    options: readonly ChoiceOption[];
    onSelect: (value: string) => void;
    disabled: boolean;
}) {
    const tc = useThemeColors();
    return (
        <View style={localStyles.choiceRow}>
            <Text style={[localStyles.choiceLabel, { color: tc.text }]}>{label}</Text>
            <View style={localStyles.choices}>
                {options.map((option) => {
                    const selected = option.value === value;
                    return (
                        <TouchableOpacity
                            key={option.value}
                            accessibilityRole="radio"
                            accessibilityLabel={`${label}: ${option.label}`}
                            accessibilityState={{ selected, disabled }}
                            disabled={disabled}
                            onPress={() => onSelect(option.value)}
                            style={[
                                localStyles.choice,
                                { borderColor: selected ? tc.tint : tc.border, backgroundColor: selected ? tc.filterBg : 'transparent' },
                            ]}
                        >
                            <Text style={{ color: selected ? tc.tint : tc.text }}>{option.label}</Text>
                        </TouchableOpacity>
                    );
                })}
            </View>
        </View>
    );
}

export function SandboxSettingsScreen() {
    const tc = useThemeColors();
    const { t, tr } = useSettingsLocalization();
    const scrollContentStyle = useSettingsScrollContent();
    const settings = useTaskStore((state) => state.settings);
    const updateSettings = useTaskStore((state) => state.updateSettings);
    const [busy, setBusy] = React.useState<'reset' | 'exit' | null>(null);
    const [failed, setFailed] = React.useState(false);
    const [settingsFailed, setSettingsFailed] = React.useState(false);

    // A built update reads the settings as stored when its write is admitted, so a newer key stays.
    const save = async (updates: Partial<AppSettings> | ((latest: AppSettings) => Partial<AppSettings>), setting: string) => {
        if (!isSandboxMode()) return;
        setSettingsFailed(false);
        try {
            await updateSettingsFromLatest((latest) => (typeof updates === 'function' ? updates(latest) : updates), { write: updateSettings, read: () => useTaskStore.getState().settings });
            await flushPendingSave();
            void logInfo('Sandbox setting applied', {
                scope: 'sandbox',
                force: true,
                extra: { releaseCheck: 'v1.3.3/sandbox-settings', setting, platform: 'mobile' },
            });
        } catch {
            setSettingsFailed(true);
        }
    };

    const editor = settings.gtd?.taskEditor;
    const featureFlags = resolveFeatureFlags(settings);
    const featureHiddenFields = new Set<TaskEditorFieldId>();
    if (!featureFlags.priorities) featureHiddenFields.add('priority');
    if (!featureFlags.timeEstimates) featureHiddenFields.add('timeEstimate');
    const order = [
        ...(editor?.order ?? []),
        ...DEFAULT_TASK_EDITOR_ORDER.filter((field) => !editor?.order?.includes(field)),
    ];
    const activePreset = resolveTaskEditorPresetId({
        order,
        hidden: new Set(editor?.hidden ?? DEFAULT_TASK_EDITOR_HIDDEN),
        sections: editor?.sections,
        sectionOpen: editor?.sectionOpen,
        featureHiddenFields,
    });

    const choosePreset = (value: string) => {
        const preset = buildTaskEditorPresetConfig(value as Exclude<TaskEditorPresetId, 'custom'>, featureHiddenFields);
        void save((latest) => ({
            gtd: {
                ...(latest.gtd ?? {}),
                taskEditor: { ...(latest.gtd?.taskEditor ?? {}), ...preset },
            },
        }), 'editor-layout');
    };

    const run = (action: 'reset' | 'exit') => {
        if (busy) return;
        setBusy(action);
        setFailed(false);
        const operation = action === 'reset' ? reloadIntoMobileSandbox() : reloadIntoPersonalWorkspace();
        void operation.catch(() => {
            setBusy(null);
            setFailed(true);
        });
    };

    return (
        <SafeAreaView style={[settingsStyles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
            <SettingsTopBar title={t('sandbox.title')} />
            <ScrollView style={settingsStyles.scrollView} contentContainerStyle={[scrollContentStyle, localStyles.content]}>
                <View style={[localStyles.card, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                    <Text style={[localStyles.title, { color: tc.text }]}>{t('sandbox.title')}</Text>
                    <Text style={[localStyles.description, { color: tc.secondaryText }]}>{t('sandbox.description')}</Text>
                    <Text style={[localStyles.notice, { color: tc.secondaryText, borderColor: tc.border }]}>{t('sandbox.notice')}</Text>
                    {failed ? <Text style={[localStyles.failure, { color: tc.danger }]}>{t('sandbox.switchFailed')}</Text> : null}
                    {busy ? (
                        <View style={localStyles.busy}>
                            <ActivityIndicator color={tc.tint} />
                            <Text style={{ color: tc.secondaryText }}>{t('sandbox.switching')}</Text>
                        </View>
                    ) : (
                        <View style={localStyles.actions}>
                            <TouchableOpacity
                                accessibilityRole="button"
                                onPress={() => run('reset')}
                                style={[localStyles.secondaryButton, { borderColor: tc.border }]}
                            >
                                <RotateCcw size={17} color={tc.tint} />
                                <Text style={[localStyles.secondaryButtonText, { color: tc.tint }]}>{t('sandbox.reset')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                accessibilityRole="button"
                                onPress={() => run('exit')}
                                style={[localStyles.primaryButton, { backgroundColor: tc.tint }]}
                            >
                                <X size={18} color={tc.onTint} />
                                <Text style={[localStyles.primaryButtonText, { color: tc.onTint }]}>{t('sandbox.exit')}</Text>
                            </TouchableOpacity>
                        </View>
                    )}
                </View>
                {settingsFailed ? <Text style={[localStyles.failure, { color: tc.danger }]}>{t('settings.feedback.saveFailed')}</Text> : null}
                <View>
                    <Text style={[settingsStyles.sectionTitle, { color: tc.secondaryText }]}>{t('settings.taskEditorLayout')}</Text>
                    <View style={[settingsStyles.settingCard, { backgroundColor: tc.cardBg }]}>
                        <ChoiceRow
                            label={tr('settings.gtdMobile.presets')}
                            value={activePreset}
                            options={[
                                { value: 'simple', label: tr('settings.gtdMobile.simple') },
                                { value: 'standard', label: tr('settings.gtdMobile.standard') },
                                { value: 'full', label: tr('settings.gtdMobile.full') },
                            ]}
                            onSelect={choosePreset}
                            disabled={busy !== null}
                        />
                    </View>
                </View>
                <View>
                    <Text style={[settingsStyles.sectionTitle, { color: tc.secondaryText }]}>{t('settings.appearance')}</Text>
                    <View style={[settingsStyles.settingCard, { backgroundColor: tc.cardBg }]}>
                        <SettingToggleRow
                            label={tr('settings.mobile.showTaskAge')}
                            description={tr('settings.mobile.displayHowLongAgoATaskWasCreatedInTask')}
                            value={settings.appearance?.showTaskAge === true}
                            onChange={(value) => void save({ appearance: { showTaskAge: value } }, 'task-age')}
                            disabled={busy !== null}
                            trackColor={{ false: tc.secondaryText, true: tc.tint }}
                        />
                    </View>
                </View>
                <View>
                    <Text style={[settingsStyles.sectionTitle, { color: tc.secondaryText }]}>{t('settings.regionalFormats')}</Text>
                    <View style={[settingsStyles.settingCard, { backgroundColor: tc.cardBg }]}>
                        <ChoiceRow
                            label={t('settings.weekStart')}
                            value={normalizeWeekStartPreference(settings.weekStart)}
                            options={[
                                { value: 'system', label: t('settings.weekStartSystem') },
                                { value: 'monday', label: t('settings.weekStartMonday') },
                                { value: 'sunday', label: t('settings.weekStartSunday') },
                                { value: 'saturday', label: t('settings.weekStartSaturday') },
                            ]}
                            onSelect={(value) => void save({ weekStart: value as AppSettings['weekStart'] }, 'week-start')}
                            disabled={busy !== null}
                        />
                        <ChoiceRow
                            label={t('settings.dateFormat')}
                            value={normalizeDateFormatSetting(settings.dateFormat)}
                            options={[
                                { value: 'system', label: t('settings.dateFormatSystem') },
                                { value: 'dmy', label: t('settings.dateFormatDmy') },
                                { value: 'mdy', label: t('settings.dateFormatMdy') },
                                { value: 'ymd', label: t('settings.dateFormatYmd') },
                            ]}
                            onSelect={(value) => void save({ dateFormat: value }, 'date-format')}
                            disabled={busy !== null}
                        />
                        <ChoiceRow
                            label={t('settings.timeFormat')}
                            value={normalizeTimeFormatSetting(settings.timeFormat)}
                            options={[
                                { value: 'system', label: t('settings.timeFormatSystem') },
                                { value: '12h', label: t('settings.timeFormat12h') },
                                { value: '24h', label: t('settings.timeFormat24h') },
                            ]}
                            onSelect={(value) => void save({ timeFormat: value }, 'time-format')}
                            disabled={busy !== null}
                        />
                    </View>
                </View>
            </ScrollView>
        </SafeAreaView>
    );
}

const localStyles = StyleSheet.create({
    content: { padding: 16, gap: 20 },
    card: { borderWidth: 1, borderRadius: 14, padding: 16, gap: 10 },
    title: { fontSize: 18, fontWeight: '700' },
    description: { fontSize: 14, lineHeight: 20 },
    notice: { fontSize: 13, lineHeight: 18, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 10 },
    failure: { fontSize: 13, lineHeight: 18 },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8, marginTop: 4 },
    busy: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
    secondaryButton: { minHeight: 44, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 7 },
    secondaryButtonText: { fontSize: 14, fontWeight: '700' },
    primaryButton: { minHeight: 44, borderRadius: 10, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 7 },
    primaryButtonText: { fontSize: 14, fontWeight: '700' },
    choiceRow: { paddingHorizontal: 16, paddingVertical: 12, gap: 10 },
    choiceLabel: { fontSize: 14, fontWeight: '600' },
    choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    choice: { borderWidth: 1, borderRadius: 9, minHeight: 40, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
});
