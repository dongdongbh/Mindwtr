import React, { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
    buildTaskEditorPresetConfig,
    resolveTaskEditorPresetId,
    type TaskEditorPresetId,
} from '@/components/task-edit/task-edit-modal.utils';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useFilledButtonColors } from '@/hooks/use-filled-button-colors';
import { CompactText } from '@/components/compact-text';
import { dispatchMobileOnboardingEvent } from '@/lib/mobile-onboarding-events';
import { logSettingsError } from '@/lib/settings-utils';
import { useToast } from '@/contexts/toast-context';
import {
    DEFAULT_TASK_EDITOR_ORDER,
    DEFAULT_TASK_EDITOR_SECTION_BY_FIELD,
    DEFAULT_TASK_EDITOR_SECTION_OPEN,
    DEFAULT_TASK_EDITOR_VISIBLE,
    FOCUS_TASK_LIMIT_OPTIONS,
    formatTimeEstimateLabel,
    getTaskEditorSectionAssignments,
    getTaskEditorSectionOpenDefaults,
    isTaskEditorSectionableField,
    normalizeClockTimeInput,
    normalizeFocusTaskLimit,
    getDefaultTaskAreaMode,
    resolveDefaultNewTaskAreaId,
    resolveFeatureFlags,
    sanitizePomodoroDurations,
    shallow,
    tFallback,
    TASK_EDITOR_FIXED_FIELDS,
    TASK_EDITOR_SECTION_ORDER,
    type DefaultProjectFlowMode,
    type FeatureSettings,
    type GtdSettings,
    type TaskEditorFieldId,
    type TaskEditorSectionId,
    type TimeEstimate,
    useTaskStore,
} from '@mindwtr/core';

import { ExactAlarmNoticeRow, useExactAlarmPermission } from './exact-alarm-notice';
import { SettingRow, SettingToggleRow } from './setting-row';
import type { SettingsScreen } from './settings.constants';
import { useSettingsLocalization, useSettingsScrollContent } from './settings.hooks';
import { SettingsTopBar } from './settings.shell';
import { styles } from './settings.styles';

type GtdScreen =
    | 'gtd'
    | 'gtd-archive'
    | 'gtd-capture'
    | 'gtd-inbox'
    | 'gtd-pomodoro'
    | 'gtd-review'
    | 'gtd-time-estimates'
    | 'gtd-task-editor';

type PomodoroSettings = NonNullable<GtdSettings['pomodoro']>;
type InboxProcessingSettings = NonNullable<GtdSettings['inboxProcessing']>;

const SHOW_TEMP_ONBOARDING_TRIGGER = false;
const DEFAULT_AREA_ACTIVE_OPTION_ID = '__active-area__';

export function GtdSettingsScreen({
    onNavigate,
    screen,
}: {
    onNavigate: (screen: SettingsScreen) => void;
    screen: GtdScreen;
}) {
    const tc = useThemeColors();
    const filledButton = useFilledButtonColors();
    const insets = useSafeAreaInsets();
    const { tr, t } = useSettingsLocalization();
    const { showToast } = useToast();
    const { settings, updateSettings, areas } = useTaskStore((state) => ({
        areas: state.areas,
        settings: state.settings,
        updateSettings: state.updateSettings,
    }), shallow);
    const scrollContentStyle = useSettingsScrollContent();
    const [taskEditorExpandedSections, setTaskEditorExpandedSections] = useState<Record<TaskEditorSectionId, boolean>>({
        basic: true,
        scheduling: false,
        organization: false,
        details: false,
    });
    const [taskEditorSelectedField, setTaskEditorSelectedField] = useState<TaskEditorFieldId | null>(null);
    const [defaultAreaPickerVisible, setDefaultAreaPickerVisible] = useState(false);

    const defaultTimeEstimatePresets: TimeEstimate[] = ['5min', '10min', '30min', '1hr', '2hr', '3hr', '4hr', '4hr+'];
    const timeEstimateOptions: TimeEstimate[] = ['5min', '10min', '15min', '30min', '1hr', '2hr', '3hr', '4hr', '4hr+'];
    const timeEstimatePresets: TimeEstimate[] = (settings.gtd?.timeEstimatePresets?.length
        ? settings.gtd.timeEstimatePresets
        : defaultTimeEstimatePresets) as TimeEstimate[];
    const defaultCaptureMethod = settings.gtd?.defaultCaptureMethod ?? 'text';
    const defaultAreaMode = getDefaultTaskAreaMode(settings);
    const sortedAreas = [...areas]
        .filter((area) => !area.deletedAt)
        .sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name));
    const defaultAreaId = resolveDefaultNewTaskAreaId(settings, sortedAreas) ?? '';
    const defaultAreaPickerValue = defaultAreaMode === 'active'
        ? DEFAULT_AREA_ACTIVE_OPTION_ID
        : defaultAreaId;
    const saveAudioAttachments = settings.gtd?.saveAudioAttachments !== false;
    const quickAddAutoClean = settings.quickAddAutoClean === true;
    const markdownEditorAssist = settings.markdownEditorAssist !== false;
    const naturalLanguageDates = settings.gtd?.naturalLanguageDates !== false;
    const inboxProcessing = settings.gtd?.inboxProcessing ?? {};
    const inboxTwoMinuteEnabled = inboxProcessing.twoMinuteEnabled !== false;
    const inboxProjectFirst = inboxProcessing.projectFirst === true;
    const inboxContextStepEnabled = inboxProcessing.contextStepEnabled !== false;
    const inboxScheduleEnabled = inboxProcessing.scheduleEnabled === true;
    const includeContextStep = settings.gtd?.weeklyReview?.includeContextStep !== false;
    const includeDailyFocusStep = settings.gtd?.dailyReview?.includeFocusStep !== false;
    const defaultScheduleTime = normalizeClockTimeInput(settings.gtd?.defaultScheduleTime) || '';
    const focusTaskLimit = normalizeFocusTaskLimit(settings.gtd?.focusTaskLimit);
    const defaultProjectFlowMode: DefaultProjectFlowMode = settings.gtd?.defaultProjectFlowMode === 'sequential'
        ? 'sequential'
        : 'parallel';
    const autoArchiveDays = Number.isFinite(settings.gtd?.autoArchiveDays)
        ? Math.max(0, Math.floor(settings.gtd?.autoArchiveDays as number))
        : 7;
    const {
        priorities: prioritiesEnabled,
        timeEstimates: timeEstimatesEnabled,
        pomodoro: pomodoroEnabled,
    } = resolveFeatureFlags(settings);
    const pomodoroCustomDurations = sanitizePomodoroDurations(settings.gtd?.pomodoro?.customDurations);
    const pomodoroLinkTask = settings.gtd?.pomodoro?.linkTask === true;
    const pomodoroAutoStartBreaks = settings.gtd?.pomodoro?.autoStartBreaks === true;
    const pomodoroAutoStartFocus = settings.gtd?.pomodoro?.autoStartFocus === true;
    // Defaults on: the alert is the point of the timer, and an off-by-default
    // switch is what made #528 read as broken.
    const pomodoroCompletionAlert = settings.gtd?.pomodoro?.completionAlert !== false;
    const { showNotice: showExactAlarmNotice } = useExactAlarmPermission(
        screen === 'gtd-pomodoro' && pomodoroCompletionAlert
    );
    const [pomodoroFocusDraft, setPomodoroFocusDraft] = useState(String(pomodoroCustomDurations.focusMinutes));
    const [pomodoroBreakDraft, setPomodoroBreakDraft] = useState(String(pomodoroCustomDurations.breakMinutes));
    const [defaultScheduleTimeDraft, setDefaultScheduleTimeDraft] = useState(defaultScheduleTime);
    const pomodoroAutoStartNoticeShownRef = React.useRef(false);

    useEffect(() => {
        if (screen !== 'gtd-task-editor') {
            setTaskEditorSelectedField(null);
            return;
        }
        setTaskEditorExpandedSections({
            basic: true,
            scheduling: typeof settings.gtd?.taskEditor?.sectionOpen?.scheduling === 'boolean'
                ? settings.gtd.taskEditor.sectionOpen.scheduling
                : DEFAULT_TASK_EDITOR_SECTION_OPEN.scheduling,
            organization: typeof settings.gtd?.taskEditor?.sectionOpen?.organization === 'boolean'
                ? settings.gtd.taskEditor.sectionOpen.organization
                : DEFAULT_TASK_EDITOR_SECTION_OPEN.organization,
            details: typeof settings.gtd?.taskEditor?.sectionOpen?.details === 'boolean'
                ? settings.gtd.taskEditor.sectionOpen.details
                : DEFAULT_TASK_EDITOR_SECTION_OPEN.details,
        });
        setTaskEditorSelectedField(null);
    }, [
        screen,
        settings.gtd?.taskEditor?.sectionOpen?.details,
        settings.gtd?.taskEditor?.sectionOpen?.organization,
        settings.gtd?.taskEditor?.sectionOpen?.scheduling,
    ]);

    useEffect(() => {
        setPomodoroFocusDraft(String(pomodoroCustomDurations.focusMinutes));
        setPomodoroBreakDraft(String(pomodoroCustomDurations.breakMinutes));
    }, [pomodoroCustomDurations.breakMinutes, pomodoroCustomDurations.focusMinutes]);

    useEffect(() => {
        setDefaultScheduleTimeDraft(defaultScheduleTime);
    }, [defaultScheduleTime]);

    const updateFeatureFlags = (next: { priorities?: boolean; timeEstimates?: boolean; pomodoro?: boolean }) => {
        updateSettings({
            features: {
                ...(settings.features ?? {}),
                ...next,
            },
        }).catch(logSettingsError);
    };

    const showPomodoroAutoStartNotice = () => {
        if (pomodoroAutoStartNoticeShownRef.current) return;
        pomodoroAutoStartNoticeShownRef.current = true;
        showToast({
            message: tr('settings.gtdMobile.pomodoroWillNowAdvancePhasesAutomatically'),
            tone: 'info',
            durationMs: 5000,
        });
    };

    const updatePomodoroSettings = (
        partial: Partial<PomodoroSettings>,
        options?: { showAutoStartNotice?: boolean }
    ) => {
        updateSettings({
            gtd: {
                ...(settings.gtd ?? {}),
                pomodoro: {
                    ...(settings.gtd?.pomodoro ?? {}),
                    ...partial,
                },
            },
        }).then(() => {
            if (options?.showAutoStartNotice) {
                showPomodoroAutoStartNotice();
            }
        }).catch(logSettingsError);
    };

    const updateGtdSettings = (partial: Partial<GtdSettings>) => {
        updateSettings({
            gtd: {
                ...(settings.gtd ?? {}),
                ...partial,
            },
        }).catch(logSettingsError);
    };

    const updateDefaultCaptureMethod = (method: 'text' | 'audio') => {
        updateGtdSettings({ defaultCaptureMethod: method });
    };

    const commitDefaultScheduleTime = () => {
        const normalized = normalizeClockTimeInput(defaultScheduleTimeDraft);
        if (normalized === null) {
            setDefaultScheduleTimeDraft(defaultScheduleTime);
            showToast({
                message: tr('settings.gtdMobile.useHhMmForTheDefaultScheduleTime'),
                tone: 'warning',
            });
            return;
        }
        setDefaultScheduleTimeDraft(normalized);
        if (normalized === defaultScheduleTime) return;
        updateGtdSettings({ defaultScheduleTime: normalized });
    };

    const savePomodoroCustomDurations = (nextDurations: { focusMinutes: number; breakMinutes: number }) => {
        updatePomodoroSettings({ customDurations: nextDurations });
        return nextDurations;
    };

    const commitPomodoroMinutes = () => {
        const focusValue = Number.parseInt(pomodoroFocusDraft, 10);
        const breakValue = Number.parseInt(pomodoroBreakDraft, 10);
        const nextDurations = savePomodoroCustomDurations(sanitizePomodoroDurations({
            focusMinutes: Number.isFinite(focusValue) ? focusValue : pomodoroCustomDurations.focusMinutes,
            breakMinutes: Number.isFinite(breakValue) ? breakValue : pomodoroCustomDurations.breakMinutes,
        }));
        setPomodoroFocusDraft(String(nextDurations.focusMinutes));
        setPomodoroBreakDraft(String(nextDurations.breakMinutes));
    };

    const updateInboxProcessing = (partial: Partial<InboxProcessingSettings>) => {
        updateSettings({
            gtd: {
                ...(settings.gtd ?? {}),
                inboxProcessing: {
                    ...(settings.gtd?.inboxProcessing ?? {}),
                    ...partial,
                },
            },
        }).catch(logSettingsError);
    };

    const updateWeeklyReviewConfig = (partial: GtdSettings['weeklyReview']) => {
        updateSettings({
            gtd: {
                ...(settings.gtd ?? {}),
                weeklyReview: {
                    ...(settings.gtd?.weeklyReview ?? {}),
                    ...partial,
                },
            },
        }).catch(logSettingsError);
    };

    const updateDailyReviewConfig = (partial: GtdSettings['dailyReview']) => {
        updateSettings({
            gtd: {
                ...(settings.gtd ?? {}),
                dailyReview: {
                    ...(settings.gtd?.dailyReview ?? {}),
                    ...partial,
                },
            },
        }).catch(logSettingsError);
    };

    const featurePomodoroLabelRaw = t('settings.featurePomodoro');
    const featurePomodoroDescRaw = t('settings.featurePomodoroDesc');
    const featurePomodoroLabel = featurePomodoroLabelRaw === 'settings.featurePomodoro'
        ? tr('settings.featurePomodoro')
        : featurePomodoroLabelRaw;
    const featurePomodoroDesc = featurePomodoroDescRaw === 'settings.featurePomodoroDesc'
        ? tr('settings.featurePomodoroDesc')
        : featurePomodoroDescRaw;
    const pomodoroSettingsLabel = tFallback(t, 'settings.pomodoroSettings', tr('settings.gtdMobile.pomodoroSettings'));
    const pomodoroCustomPresetLabelRaw = t('settings.pomodoroCustomPreset');
    const pomodoroCustomPresetLabel = pomodoroCustomPresetLabelRaw === 'settings.pomodoroCustomPreset'
        ? tr('settings.pomodoroCustomPreset')
        : pomodoroCustomPresetLabelRaw;
    const pomodoroCustomPresetDescRaw = t('settings.pomodoroCustomPresetDesc');
    const pomodoroCustomPresetDesc = pomodoroCustomPresetDescRaw === 'settings.pomodoroCustomPresetDesc'
        ? tr('settings.pomodoroCustomPresetDesc')
        : pomodoroCustomPresetDescRaw;
    const pomodoroFocusMinutesLabelRaw = t('settings.pomodoroFocusMinutes');
    const pomodoroFocusMinutesLabel = pomodoroFocusMinutesLabelRaw === 'settings.pomodoroFocusMinutes'
        ? tr('settings.pomodoroFocusMinutes')
        : pomodoroFocusMinutesLabelRaw;
    const pomodoroBreakMinutesLabelRaw = t('settings.pomodoroBreakMinutes');
    const pomodoroBreakMinutesLabel = pomodoroBreakMinutesLabelRaw === 'settings.pomodoroBreakMinutes'
        ? tr('settings.pomodoroBreakMinutes')
        : pomodoroBreakMinutesLabelRaw;
    const pomodoroLinkTaskLabel = tFallback(
        t,
        'settings.pomodoroLinkTask',
        tr('settings.pomodoroLinkTask')
    );
    const pomodoroLinkTaskDesc = tFallback(
        t,
        'settings.pomodoroLinkTaskDesc',
        tr('settings.pomodoroLinkTaskDesc')
    );
    const pomodoroAutoStartBreaksLabelRaw = t('settings.pomodoroAutoStartBreaks');
    const pomodoroAutoStartBreaksLabel = pomodoroAutoStartBreaksLabelRaw === 'settings.pomodoroAutoStartBreaks'
        ? tr('settings.gtdMobile.autoStartBreaks')
        : pomodoroAutoStartBreaksLabelRaw;
    const pomodoroAutoStartBreaksDescRaw = t('settings.pomodoroAutoStartBreaksDesc');
    const pomodoroAutoStartBreaksDesc = pomodoroAutoStartBreaksDescRaw === 'settings.pomodoroAutoStartBreaksDesc'
        ? tr('settings.gtdMobile.startTheBreakTimerAutomaticallyWhenAFocusSessionEnds')
        : pomodoroAutoStartBreaksDescRaw;
    const pomodoroAutoStartFocusLabelRaw = t('settings.pomodoroAutoStartFocus');
    const pomodoroAutoStartFocusLabel = pomodoroAutoStartFocusLabelRaw === 'settings.pomodoroAutoStartFocus'
        ? tr('settings.gtdMobile.autoStartFocus')
        : pomodoroAutoStartFocusLabelRaw;
    const pomodoroAutoStartFocusDescRaw = t('settings.pomodoroAutoStartFocusDesc');
    const pomodoroAutoStartFocusDesc = pomodoroAutoStartFocusDescRaw === 'settings.pomodoroAutoStartFocusDesc'
        ? tr('settings.gtdMobile.startTheNextFocusSessionAutomaticallyWhenABreakEnds')
        : pomodoroAutoStartFocusDescRaw;
    const pomodoroCompletionAlertLabel = tFallback(t, 'settings.pomodoroCompletionAlert', 'Session-end alert');
    const pomodoroCompletionAlertDesc = tFallback(
        t,
        'settings.pomodoroCompletionAlertDesc',
        'Play a sound and show a notification when a focus session or break ends.'
    );
    const defaultScheduleTimeLabel = tFallback(t, 'settings.defaultScheduleTime', tr('settings.gtdMobile.defaultScheduleTime'));
    const defaultScheduleTimeDesc = tFallback(
        t,
        'settings.defaultScheduleTimeDesc',
        tr('settings.gtdMobile.optionalPreFillsManualStartDueAndReviewTimeFields')
    );
    const focusTaskLimitLabel = tFallback(t, 'settings.focusTaskLimit', tr('settings.focusTaskLimit'));
    const focusTaskLimitDesc = tFallback(
        t,
        'settings.focusTaskLimitDesc',
        tr('settings.focusTaskLimitDesc')
    );
    const defaultProjectFlowModeLabel = tFallback(
        t,
        'settings.defaultProjectFlowMode',
        'Default project flow'
    );
    const defaultProjectFlowModeDesc = tFallback(
        t,
        'settings.defaultProjectFlowModeDesc',
        'Applies only when creating new projects.'
    );
    const defaultAreaLabel = t('settings.defaultArea');
    const defaultAreaDesc = t('settings.defaultAreaDesc');
    const defaultAreaNoneLabel = t('settings.defaultAreaNone');
    const defaultAreaActiveLabel = t('settings.defaultAreaActive');
    const captureSettingsTitle = tFallback(t, 'settings.captureSettings', tr('settings.gtdMobile.captureDefaults'));
    const quickAddAutoCleanLabel = t('settings.quickAddAutoClean');
    const quickAddAutoCleanDesc = t('settings.quickAddAutoCleanDesc');
    const markdownEditorAssistLabel = t('settings.markdownEditorAssist');
    const markdownEditorAssistDesc = t('settings.markdownEditorAssistDesc');
    const naturalLanguageDatesLabel = t('settings.naturalLanguageDates');
    const naturalLanguageDatesDesc = t('settings.naturalLanguageDatesDesc');
    const reviewSettingsTitle = tFallback(t, 'settings.reviewSettings', tr('settings.gtdMobile.reviewSteps'));
    const inboxSettingsTitle = tFallback(t, 'settings.inboxProcessing', tr('settings.inboxProcessing'));
    const projectFlowModeOptions: Array<{ id: DefaultProjectFlowMode; label: string }> = [
        { id: 'parallel', label: tFallback(t, 'settings.projectFlowParallel', 'Parallel') },
        { id: 'sequential', label: tFallback(t, 'settings.projectFlowSequential', 'Sequential') },
    ];
    const captureMethodOptions: { id: 'text' | 'audio'; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
        { id: 'text', label: t('settings.captureDefaultText'), icon: 'text-outline' },
        { id: 'audio', label: t('settings.captureDefaultAudio'), icon: 'mic-outline' },
    ];
    const defaultAreaOptions = [
        { id: '', label: defaultAreaNoneLabel },
        { id: DEFAULT_AREA_ACTIVE_OPTION_ID, label: defaultAreaActiveLabel },
        ...sortedAreas.map((area) => ({ id: area.id, label: area.name })),
    ];
    const defaultAreaSelectedLabel = defaultAreaOptions.find((option) => option.id === defaultAreaPickerValue)?.label ?? defaultAreaNoneLabel;
    const selectDefaultArea = (areaId: string) => {
        if (areaId === DEFAULT_AREA_ACTIVE_OPTION_ID) {
            updateGtdSettings({ defaultAreaMode: 'active', defaultAreaId: null });
        } else if (areaId) {
            updateGtdSettings({ defaultAreaMode: 'fixed', defaultAreaId: areaId });
        } else {
            updateGtdSettings({ defaultAreaMode: 'none', defaultAreaId: null });
        }
        setDefaultAreaPickerVisible(false);
    };

    const renderGtdNavigationRow = (
        title: string,
        description: string | null,
        nextScreen: SettingsScreen,
        options?: { first?: boolean; testID?: string }
    ) => (
        <TouchableOpacity
            testID={options?.testID}
            style={[
                styles.gtdNavigationRow,
                { borderTopColor: tc.border },
                options?.first && { borderTopWidth: 0 },
            ]}
            accessibilityRole="button"
            onPress={() => onNavigate(nextScreen)}
            activeOpacity={0.75}
        >
            <View style={styles.settingInfo}>
                <Text style={[styles.settingLabel, { color: tc.text }]}>{title}</Text>
                {description ? (
                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{description}</Text>
                ) : null}
            </View>
            <Ionicons name="chevron-forward" size={18} color={tc.secondaryText} />
        </TouchableOpacity>
    );

    if (screen === 'gtd') {
        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SettingsTopBar title={t('settings.gtd')} />
                <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                    <Text style={[styles.description, { color: tc.secondaryText }]}>{t('settings.gtdDesc')}</Text>
                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginBottom: 12 }]}>
                        <SettingRow
                            label={t('settings.features')}
                            description={t('settings.featuresDesc')}
                        />
                        <SettingToggleRow
                            divider
                            label={featurePomodoroLabel}
                            description={featurePomodoroDesc}
                            value={pomodoroEnabled}
                            onChange={(value) => updateFeatureFlags({ pomodoro: value })}
                        />
                        {pomodoroEnabled && renderGtdNavigationRow(
                            pomodoroSettingsLabel,
                            tr('settings.gtdMobile.customPresetTaskLinkingAndAutoStartBehavior'),
                            'gtd-pomodoro',
                            { testID: 'gtd-nav-pomodoro' }
                        )}
                    </View>

                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                        <SettingRow
                            label={defaultScheduleTimeLabel}
                            description={defaultScheduleTimeDesc}
                        >
                            <TextInput
                                value={defaultScheduleTimeDraft}
                                onChangeText={setDefaultScheduleTimeDraft}
                                onBlur={commitDefaultScheduleTime}
                                placeholder={tr('settings.gtdMobile.hhMm')}
                                placeholderTextColor={tc.secondaryText}
                                keyboardType="numbers-and-punctuation"
                                style={[
                                    styles.textInput,
                                    styles.inlineTextInput,
                                    styles.gtdTimeInput,
                                    { backgroundColor: tc.bg, borderColor: tc.border, color: tc.text },
                                ]}
                            />
                        </SettingRow>
                        <View style={[styles.settingRowColumn, { borderTopWidth: 1, borderTopColor: tc.border, gap: 12 }]}>
                            <View>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{focusTaskLimitLabel}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{focusTaskLimitDesc}</Text>
                            </View>
                            <View style={[styles.gtdSegmentedControl, { backgroundColor: tc.bg, borderColor: tc.border }]}>
                                {FOCUS_TASK_LIMIT_OPTIONS.map((option) => {
                                    const selected = focusTaskLimit === option;
                                    return (
                                        <TouchableOpacity
                                            key={option}
                                            accessibilityRole="button"
                                            accessibilityState={{ selected }}
                                            style={[
                                                styles.gtdSegmentedOption,
                                                { backgroundColor: selected ? tc.filterBg : 'transparent' },
                                            ]}
                                            onPress={() => updateGtdSettings({ focusTaskLimit: option })}
                                            activeOpacity={0.8}
                                        >
                                            <CompactText
                                                style={[styles.gtdSegmentedOptionText, { color: selected ? tc.tint : tc.secondaryText }]}
                                                numberOfLines={2}
                                            >
                                                {option}
                                            </CompactText>
                                        </TouchableOpacity>
                                    );
                                })}
                            </View>
                        </View>
                        <View style={[styles.settingRowColumn, { borderTopWidth: 1, borderTopColor: tc.border, gap: 12 }]}>
                            <View>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{defaultProjectFlowModeLabel}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{defaultProjectFlowModeDesc}</Text>
                            </View>
                            <View style={[styles.gtdSegmentedControl, { backgroundColor: tc.bg, borderColor: tc.border }]}>
                                {projectFlowModeOptions.map((option) => {
                                    const selected = defaultProjectFlowMode === option.id;
                                    return (
                                        <TouchableOpacity
                                            key={option.id}
                                            accessibilityRole="button"
                                            accessibilityState={{ selected }}
                                            style={[
                                                styles.gtdSegmentedOption,
                                                { backgroundColor: selected ? tc.filterBg : 'transparent' },
                                            ]}
                                            onPress={() => updateGtdSettings({ defaultProjectFlowMode: option.id })}
                                            activeOpacity={0.8}
                                        >
                                            <CompactText
                                                style={[styles.gtdSegmentedOptionText, { color: selected ? tc.tint : tc.secondaryText }]}
                                                numberOfLines={2}
                                            >
                                                {option.label}
                                            </CompactText>
                                        </TouchableOpacity>
                                    );
                                })}
                            </View>
                        </View>
                        {timeEstimatesEnabled && renderGtdNavigationRow(
                            t('settings.timeEstimatePresets'),
                            t('settings.timeEstimatePresetsDesc'),
                            'gtd-time-estimates',
                            { testID: 'gtd-nav-time-estimates' }
                        )}
                        {renderGtdNavigationRow(
                            t('settings.autoArchive'),
                            t('settings.autoArchiveDesc'),
                            'gtd-archive',
                            { testID: 'gtd-nav-archive' }
                        )}
                    </View>

                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                        {renderGtdNavigationRow(
                            t('settings.taskEditorLayout'),
                            t('settings.taskEditorLayoutDesc'),
                            'gtd-task-editor',
                            { first: true, testID: 'gtd-nav-task-editor' }
                        )}
                        {renderGtdNavigationRow(
                            captureSettingsTitle,
                            t('settings.captureDefaultDesc'),
                            'gtd-capture',
                            { testID: 'gtd-nav-capture' }
                        )}
                    </View>

                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                        {renderGtdNavigationRow(
                            reviewSettingsTitle,
                            tr('settings.gtdMobile.chooseWhichOptionalStepsAppearInDailyAndWeeklyReview'),
                            'gtd-review',
                            { first: true, testID: 'gtd-nav-review' }
                        )}
                        {renderGtdNavigationRow(
                            inboxSettingsTitle,
                            t('settings.inboxProcessingDesc'),
                            'gtd-inbox',
                            { testID: 'gtd-nav-inbox' }
                        )}
                    </View>

                    {SHOW_TEMP_ONBOARDING_TRIGGER ? (
                        <TouchableOpacity
                            accessibilityRole="button"
                            activeOpacity={0.75}
                            onPress={dispatchMobileOnboardingEvent}
                            style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}
                            testID="mobile-onboarding-test-trigger"
                        >
                            <View style={styles.settingRow}>
                                <View style={styles.settingInfo}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>Temporary onboarding test</Text>
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                        Opens the mobile first-run onboarding flow so you can test Sync, Import, and Start fresh.
                                    </Text>
                                </View>
                                <Text style={[styles.linkText, { color: tc.tint }]}>Open</Text>
                            </View>
                        </TouchableOpacity>
                    ) : null}
                </ScrollView>
            </SafeAreaView>
        );
    }

    if (screen === 'gtd-pomodoro') {
        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SettingsTopBar title={pomodoroSettingsLabel} />
                <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                    <Text style={[styles.description, { color: tc.secondaryText }]}>{featurePomodoroDesc}</Text>
                    {!pomodoroEnabled ? (
                        <TouchableOpacity
                            style={[styles.settingCard, { backgroundColor: tc.cardBg }]}
                            accessibilityRole="button"
                            onPress={() => updateFeatureFlags({ pomodoro: true })}
                            activeOpacity={0.75}
                        >
                            <View style={styles.settingRow}>
                                <Text style={[styles.settingLabel, { color: tc.tint }]}>{featurePomodoroLabel}</Text>
                            </View>
                        </TouchableOpacity>
                    ) : (
                        <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                            <View style={[styles.settingRowColumn, { gap: 12 }]}>
                                <View style={styles.settingInfo}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>{pomodoroCustomPresetLabel}</Text>
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{pomodoroCustomPresetDesc}</Text>
                                </View>
                                <View style={styles.inlineInputRow}>
                                    <View style={styles.inlineInputGroup}>
                                        <Text style={[styles.inlineInputLabel, { color: tc.secondaryText }]}>{pomodoroFocusMinutesLabel}</Text>
                                        <TextInput
                                            value={pomodoroFocusDraft}
                                            onChangeText={setPomodoroFocusDraft}
                                            onBlur={commitPomodoroMinutes}
                                            keyboardType="number-pad"
                                            accessibilityLabel={pomodoroFocusMinutesLabel}
                                            style={[styles.textInput, styles.inlineTextInput, { borderColor: tc.border, color: tc.text }]}
                                        />
                                    </View>
                                    <View style={styles.inlineInputGroup}>
                                        <Text style={[styles.inlineInputLabel, { color: tc.secondaryText }]}>{pomodoroBreakMinutesLabel}</Text>
                                        <TextInput
                                            value={pomodoroBreakDraft}
                                            onChangeText={setPomodoroBreakDraft}
                                            onBlur={commitPomodoroMinutes}
                                            keyboardType="number-pad"
                                            accessibilityLabel={pomodoroBreakMinutesLabel}
                                            style={[styles.textInput, styles.inlineTextInput, { borderColor: tc.border, color: tc.text }]}
                                        />
                                    </View>
                                </View>
                            </View>
                            <SettingToggleRow
                                divider
                                label={pomodoroLinkTaskLabel}
                                description={pomodoroLinkTaskDesc}
                                value={pomodoroLinkTask}
                                onChange={(value) => updatePomodoroSettings({ linkTask: value })}
                            />
                            <SettingToggleRow
                                divider
                                label={pomodoroAutoStartBreaksLabel}
                                description={pomodoroAutoStartBreaksDesc}
                                value={pomodoroAutoStartBreaks}
                                onChange={(value) => updatePomodoroSettings(
                                    { autoStartBreaks: value },
                                    { showAutoStartNotice: value && !pomodoroAutoStartBreaks }
                                )}
                            />
                            <SettingToggleRow
                                divider
                                label={pomodoroAutoStartFocusLabel}
                                description={pomodoroAutoStartFocusDesc}
                                value={pomodoroAutoStartFocus}
                                onChange={(value) => updatePomodoroSettings(
                                    { autoStartFocus: value },
                                    { showAutoStartNotice: value && !pomodoroAutoStartFocus }
                                )}
                            />
                            <SettingToggleRow
                                divider
                                label={pomodoroCompletionAlertLabel}
                                description={pomodoroCompletionAlertDesc}
                                value={pomodoroCompletionAlert}
                                onChange={(value) => updatePomodoroSettings({ completionAlert: value })}
                            />
                            {showExactAlarmNotice && (
                                <ExactAlarmNoticeRow
                                    divider
                                    label={t('settings.exactAlarmsLabel')}
                                    description={t('settings.exactAlarmsDesc')}
                                    actionLabel={t('settings.exactAlarmsAllow')}
                                />
                            )}
                        </View>
                    )}
                </ScrollView>
            </SafeAreaView>
        );
    }

    if (screen === 'gtd-capture') {
        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SettingsTopBar title={captureSettingsTitle} />
                <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                    <Text style={[styles.description, { color: tc.secondaryText }]}>{t('settings.captureDefaultDesc')}</Text>
                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                        <SettingRow
                            label={t('settings.captureDefault')}
                            description={t('settings.captureDefaultDesc')}
                        />
                        <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                            <View style={[styles.gtdSegmentedControl, { backgroundColor: tc.bg, borderColor: tc.border }]}>
                                {captureMethodOptions.map((option) => {
                                    const selected = defaultCaptureMethod === option.id;
                                    return (
                                        <TouchableOpacity
                                            key={option.id}
                                            accessibilityRole="button"
                                            accessibilityState={{ selected }}
                                            style={[
                                                styles.gtdSegmentedOption,
                                                { backgroundColor: selected ? tc.filterBg : 'transparent' },
                                            ]}
                                            onPress={() => updateDefaultCaptureMethod(option.id)}
                                            activeOpacity={0.8}
                                        >
                                            <Ionicons
                                                name={option.icon}
                                                size={16}
                                                color={selected ? tc.tint : tc.secondaryText}
                                            />
                                            <CompactText
                                                style={[styles.gtdSegmentedOptionText, { color: selected ? tc.tint : tc.secondaryText }]}
                                                numberOfLines={2}
                                            >
                                                {option.label}
                                            </CompactText>
                                        </TouchableOpacity>
                                    );
                                })}
                            </View>
                        </View>
                        <TouchableOpacity
                            testID="default-area-picker-button"
                            style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                            accessibilityRole="button"
                            accessibilityLabel={`${defaultAreaLabel}: ${defaultAreaSelectedLabel}`}
                            onPress={() => setDefaultAreaPickerVisible(true)}
                            activeOpacity={0.75}
                        >
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{defaultAreaLabel}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{defaultAreaDesc}</Text>
                            </View>
                            <View style={[styles.menuRight, { flexShrink: 1, maxWidth: '42%' }]}>
                            <CompactText
                                style={[styles.settingValue, { color: tc.secondaryText }]}
                                numberOfLines={2}
                            >
                                {defaultAreaSelectedLabel}
                            </CompactText>
                                <Ionicons name="chevron-forward" size={18} color={tc.secondaryText} />
                            </View>
                        </TouchableOpacity>
                        {defaultCaptureMethod === 'audio' ? (
                            <SettingToggleRow
                                divider
                                label={t('settings.captureSaveAudio')}
                                description={t('settings.captureSaveAudioDesc')}
                                value={saveAudioAttachments}
                                onChange={(value) => {
                                    updateSettings({
                                        gtd: {
                                            ...(settings.gtd ?? {}),
                                            saveAudioAttachments: value,
                                        },
                                    }).catch(logSettingsError);
                                }}
                            />
                        ) : null}
                        <SettingToggleRow
                            divider
                            label={quickAddAutoCleanLabel}
                            description={quickAddAutoCleanDesc}
                            value={quickAddAutoClean}
                            onChange={(value) => {
                                updateSettings({ quickAddAutoClean: value }).catch(logSettingsError);
                            }}
                        />
                        <SettingToggleRow
                            divider
                            label={naturalLanguageDatesLabel}
                            description={naturalLanguageDatesDesc}
                            value={naturalLanguageDates}
                            onChange={(value) => {
                                updateSettings({
                                    gtd: {
                                        ...(settings.gtd ?? {}),
                                        naturalLanguageDates: value,
                                    },
                                }).catch(logSettingsError);
                            }}
                        />
                        <SettingToggleRow
                            divider
                            label={markdownEditorAssistLabel}
                            description={markdownEditorAssistDesc}
                            value={markdownEditorAssist}
                            onChange={(value) => {
                                updateSettings({ markdownEditorAssist: value }).catch(logSettingsError);
                            }}
                        />
                    </View>
                </ScrollView>
                <Modal
                    visible={defaultAreaPickerVisible}
                    transparent
                    animationType="fade"
                    onRequestClose={() => setDefaultAreaPickerVisible(false)}
                >
                    <Pressable style={styles.pickerOverlay} onPress={() => setDefaultAreaPickerVisible(false)}>
                        <Pressable
                            style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                            onPress={(event) => event.stopPropagation()}
                        >
                            <Text style={[styles.pickerTitle, { color: tc.text }]}>{defaultAreaLabel}</Text>
                            <ScrollView style={styles.pickerList} contentContainerStyle={styles.pickerListContent}>
                                {defaultAreaOptions.map((option) => {
                                    const selected = defaultAreaPickerValue === option.id;
                                    return (
                                        <TouchableOpacity
                                            key={option.id || 'none'}
                                            testID={`default-area-picker-option-${option.id || 'none'}`}
                                            accessibilityRole="button"
                                            accessibilityState={{ selected }}
                                            style={[
                                                styles.pickerOption,
                                                {
                                                    backgroundColor: selected ? tc.filterBg : 'transparent',
                                                    borderColor: selected ? tc.tint : tc.border,
                                                },
                                            ]}
                                            onPress={() => selectDefaultArea(option.id)}
                                            activeOpacity={0.8}
                                        >
                                            <CompactText
                                                style={[styles.pickerOptionText, { color: selected ? tc.tint : tc.text }]}
                                                numberOfLines={2}
                                            >
                                                {option.label}
                                            </CompactText>
                                            {selected ? <Ionicons name="checkmark" size={18} color={tc.tint} /> : null}
                                        </TouchableOpacity>
                                    );
                                })}
                            </ScrollView>
                        </Pressable>
                    </Pressable>
                </Modal>
            </SafeAreaView>
        );
    }

    if (screen === 'gtd-review') {
        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SettingsTopBar title={reviewSettingsTitle} />
                <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                    <Text style={[styles.description, { color: tc.secondaryText }]}>
                        {tr('settings.gtdMobile.chooseWhichOptionalStepsAppearInDailyAndWeeklyReview')}
                    </Text>
                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                        <SettingRow
                            label={t('settings.dailyReviewConfig')}
                            description={t('settings.dailyReviewConfigDesc')}
                        />
                        <SettingToggleRow
                            divider
                            label={t('settings.dailyReviewIncludeFocusStep')}
                            description={t('settings.dailyReviewIncludeFocusStepDesc')}
                            value={includeDailyFocusStep}
                            onChange={(value) => updateDailyReviewConfig({ includeFocusStep: value })}
                        />
                        <SettingRow
                            divider
                            label={t('settings.weeklyReviewConfig')}
                            description={t('settings.weeklyReviewConfigDesc')}
                        />
                        <SettingToggleRow
                            divider
                            label={t('settings.weeklyReviewIncludeContextsStep')}
                            description={t('settings.weeklyReviewIncludeContextsStepDesc')}
                            value={includeContextStep}
                            onChange={(value) => updateWeeklyReviewConfig({ includeContextStep: value })}
                        />
                    </View>
                </ScrollView>
            </SafeAreaView>
        );
    }

    if (screen === 'gtd-inbox') {
        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SettingsTopBar title={inboxSettingsTitle} />
                <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                    <Text style={[styles.description, { color: tc.secondaryText }]}>{t('settings.inboxProcessingDesc')}</Text>
                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                        <SettingToggleRow
                            label={t('settings.inboxTwoMinuteEnabled')}
                            value={inboxTwoMinuteEnabled}
                            onChange={(value) => updateInboxProcessing({ twoMinuteEnabled: value })}
                        />
                        <SettingToggleRow
                            divider
                            label={t('settings.inboxProjectFirst')}
                            value={inboxProjectFirst}
                            onChange={(value) => updateInboxProcessing({ projectFirst: value })}
                        />
                        <SettingToggleRow
                            divider
                            label={t('settings.inboxContextStepEnabled')}
                            value={inboxContextStepEnabled}
                            onChange={(value) => updateInboxProcessing({ contextStepEnabled: value })}
                        />
                        <SettingToggleRow
                            divider
                            label={t('settings.inboxScheduleEnabled')}
                            value={inboxScheduleEnabled}
                            onChange={(value) => updateInboxProcessing({ scheduleEnabled: value })}
                        />
                    </View>
                </ScrollView>
            </SafeAreaView>
        );
    }

    if (screen === 'gtd-archive') {
        const autoArchiveOptions = [0, 1, 3, 7, 14, 30, 60];
        const formatAutoArchiveLabel = (days: number) => {
            if (days <= 0) return t('settings.autoArchiveNever');
            return `${days} ${tr('common.days')}`;
        };

        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SettingsTopBar title={t('settings.autoArchive')} />
                <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                    <Text style={[styles.description, { color: tc.secondaryText }]}>{t('settings.autoArchiveDesc')}</Text>
                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                        {autoArchiveOptions.map((days, idx) => {
                            const selected = autoArchiveDays === days;
                            return (
                                <TouchableOpacity
                                    key={days}
                                    style={[styles.settingRow, idx > 0 && { borderTopWidth: 1, borderTopColor: tc.border }]}
                                    onPress={() => {
                                        updateSettings({
                                            gtd: {
                                                ...(settings.gtd ?? {}),
                                                autoArchiveDays: days,
                                            },
                                        }).catch(logSettingsError);
                                    }}
                                >
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>{formatAutoArchiveLabel(days)}</Text>
                                    {selected && <Text style={{ color: '#3B82F6', fontSize: 20 }}>✓</Text>}
                                </TouchableOpacity>
                            );
                        })}
                    </View>
                </ScrollView>
            </SafeAreaView>
        );
    }

    if (screen === 'gtd-time-estimates') {
        if (!timeEstimatesEnabled) {
            return (
                <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                    <SettingsTopBar title={t('settings.timeEstimatePresets')} />
                    <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                        <Text style={[styles.description, { color: tc.secondaryText }]}>{t('settings.timeEstimatePresetsDisabled')}</Text>
                        <TouchableOpacity
                            style={[styles.settingCard, { backgroundColor: tc.cardBg }]}
                            onPress={() => updateFeatureFlags({ timeEstimates: true })}
                        >
                            <View style={styles.settingRow}>
                                <Text style={[styles.settingLabel, { color: tc.tint }]}>{t('settings.enableTimeEstimates')}</Text>
                            </View>
                        </TouchableOpacity>
                    </ScrollView>
                </SafeAreaView>
            );
        }

        const togglePreset = (value: TimeEstimate) => {
            const isSelected = timeEstimatePresets.includes(value);
            if (isSelected && timeEstimatePresets.length <= 1) return;

            const next = isSelected ? timeEstimatePresets.filter((v) => v !== value) : [...timeEstimatePresets, value];
            const ordered = timeEstimateOptions.filter((v) => next.includes(v));
            updateSettings({
                gtd: {
                    ...(settings.gtd ?? {}),
                    timeEstimatePresets: ordered,
                },
            }).catch(logSettingsError);
        };

        const resetToDefault = () => {
            updateSettings({
                gtd: {
                    ...(settings.gtd ?? {}),
                    timeEstimatePresets: [...defaultTimeEstimatePresets],
                },
            }).catch(logSettingsError);
        };

        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SettingsTopBar title={t('settings.timeEstimatePresets')} />
                <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                    <Text style={[styles.description, { color: tc.secondaryText }]}>{t('settings.timeEstimatePresetsDesc')}</Text>
                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                        {timeEstimateOptions.map((value, idx) => {
                            const selected = timeEstimatePresets.includes(value);
                            return (
                                <TouchableOpacity
                                    key={value}
                                    style={[styles.settingRow, idx > 0 && { borderTopWidth: 1, borderTopColor: tc.border }]}
                                    onPress={() => togglePreset(value)}
                                >
                                    <CompactText
                                        style={[styles.settingLabel, { color: tc.text }]}
                                        numberOfLines={2}
                                    >
                                        {formatTimeEstimateLabel(value, { t })}
                                    </CompactText>
                                    {selected && <Text style={{ color: '#3B82F6', fontSize: 20 }}>✓</Text>}
                                </TouchableOpacity>
                            );
                        })}
                    </View>
                    <TouchableOpacity
                        style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}
                        onPress={resetToDefault}
                    >
                        <View style={styles.settingRow}>
                            <CompactText
                                style={[styles.settingLabel, { color: tc.text }]}
                                numberOfLines={2}
                            >
                                {t('settings.resetToDefault')}
                            </CompactText>
                        </View>
                    </TouchableOpacity>
                </ScrollView>
            </SafeAreaView>
        );
    }

    if (screen !== 'gtd-task-editor') {
        throw new Error(`Unhandled GTD settings screen: ${screen}`);
    }

    const featureHiddenFields = new Set<TaskEditorFieldId>();
    if (!prioritiesEnabled) featureHiddenFields.add('priority');
    if (!timeEstimatesEnabled) featureHiddenFields.add('timeEstimate');

    const defaultTaskEditorOrder = DEFAULT_TASK_EDITOR_ORDER;
    const defaultVisibleFields = DEFAULT_TASK_EDITOR_VISIBLE;
    const defaultTaskEditorHidden = defaultTaskEditorOrder.filter(
        (id) => !defaultVisibleFields.includes(id) || featureHiddenFields.has(id)
    );
    const known = new Set(defaultTaskEditorOrder);
    const savedOrder = (settings.gtd?.taskEditor?.order ?? []).filter((id) => known.has(id));
    const taskEditorOrder = [...savedOrder, ...defaultTaskEditorOrder.filter((id) => !savedOrder.includes(id))];
    const savedHidden = settings.gtd?.taskEditor?.hidden ?? defaultTaskEditorHidden;
    const hiddenSet = new Set(savedHidden.filter((id) => known.has(id)));
    const taskEditorSections = getTaskEditorSectionAssignments(settings.gtd?.taskEditor);
    const taskEditorSectionOpen = getTaskEditorSectionOpenDefaults(settings.gtd?.taskEditor);
    const taskEditorDefaultOpenLabel = t('settings.taskEditorDefaultOpen');
    const resolvedTaskEditorDefaultOpenLabel = taskEditorDefaultOpenLabel === 'settings.taskEditorDefaultOpen'
        ? 'Open sections by default'
        : taskEditorDefaultOpenLabel;
    const taskEditorPresetOptions: { id: Exclude<TaskEditorPresetId, 'custom'>; label: string }[] = [
        { id: 'simple', label: tr('settings.gtdMobile.simple') },
        { id: 'standard', label: tr('settings.gtdMobile.standard') },
        { id: 'full', label: tr('settings.gtdMobile.full') },
    ];
    const activeTaskEditorPreset = resolveTaskEditorPresetId({
        order: taskEditorOrder,
        hidden: hiddenSet,
        sections: settings.gtd?.taskEditor?.sections,
        sectionOpen: settings.gtd?.taskEditor?.sectionOpen,
        featureHiddenFields,
    });
    const taskEditorHelperText = tr('settings.gtdMobile.chooseAPresetThenOpenASectionToFineTune');
    const taskEditorCustomLabel = tr('settings.gtdMobile.currentLayoutCustom');
    const taskEditorPresetLabel = tr('settings.gtdMobile.presets');
    const taskEditorMoveSectionLabel = tr('settings.gtdMobile.moveToSection');
    const taskEditorOrderLabel = tr('settings.gtdMobile.orderWithinSection');
    const taskEditorKeepOpenLabel = tr('settings.gtdMobile.startTaskEditingWithThisSectionExpanded');
    const showInEditorLabel = tr('settings.gtdMobile.showInEditor');
    const hideInEditorLabel = tr('settings.gtdMobile.hideFromEditor');
    const moveUpLabel = tr('projects.moveUp');
    const moveDownLabel = tr('projects.moveDown');
    const doneLabel = tFallback(t, 'common.done', tr('nav.done'));

    const fieldLabel = (fieldId: TaskEditorFieldId) => {
        switch (fieldId) {
            case 'status':
                return t('taskEdit.statusLabel');
            case 'project':
                return t('taskEdit.projectLabel');
            case 'section':
                return t('taskEdit.sectionLabel');
            case 'area':
                return t('taskEdit.areaLabel');
            case 'priority':
                return t('taskEdit.priorityLabel');
            case 'energyLevel':
                return t('taskEdit.energyLevel');
            case 'assignedTo':
                return t('taskEdit.assignedTo');
            case 'contexts':
                return t('taskEdit.contextsLabel');
            case 'description':
                return t('taskEdit.descriptionLabel');
            case 'location':
                return t('taskEdit.locationLabel');
            case 'tags':
                return t('taskEdit.tagsLabel');
            case 'timeEstimate':
                return t('taskEdit.timeEstimateLabel');
            case 'recurrence':
                return t('taskEdit.recurrenceLabel');
            case 'startTime':
                return t('taskEdit.startDateLabel');
            case 'dueDate':
                return t('taskEdit.dueDateLabel');
            case 'reviewAt':
                return t('taskEdit.reviewDateLabel');
            case 'attachments':
                return t('attachments.title');
            case 'checklist':
                return t('taskEdit.checklist');
            default:
                return fieldId;
        }
    };

    const sectionLabel = (sectionId: TaskEditorSectionId) => {
        switch (sectionId) {
            case 'basic':
                return t('taskEdit.basic');
            case 'scheduling':
                return t('taskEdit.scheduling');
            case 'organization':
                return t('taskEdit.organization');
            case 'details':
                return t('taskEdit.details');
            default:
                return sectionId;
        }
    };

    const saveTaskEditor = (
        next: {
            order?: TaskEditorFieldId[];
            hidden?: TaskEditorFieldId[];
            sections?: Partial<Record<TaskEditorFieldId, TaskEditorSectionId>>;
            sectionOpen?: Partial<Record<TaskEditorSectionId, boolean>>;
        },
        nextFeatures?: FeatureSettings
    ) => {
        updateSettings({
            ...(nextFeatures ? { features: nextFeatures } : null),
            gtd: {
                ...(settings.gtd ?? {}),
                taskEditor: {
                    ...(settings.gtd?.taskEditor ?? {}),
                    ...next,
                },
            },
        }).catch(logSettingsError);
    };

    const toggleFieldVisibility = (fieldId: TaskEditorFieldId) => {
        const nextHidden = new Set(hiddenSet);
        if (nextHidden.has(fieldId)) nextHidden.delete(fieldId);
        else nextHidden.add(fieldId);
        const nextFeatures = { ...(settings.features ?? {}) };
        if (fieldId === 'priority') nextFeatures.priorities = !nextHidden.has('priority');
        if (fieldId === 'timeEstimate') nextFeatures.timeEstimates = !nextHidden.has('timeEstimate');
        saveTaskEditor({ order: taskEditorOrder, hidden: Array.from(nextHidden) }, nextFeatures);
    };

    const moveOrderInGroup = (fieldId: TaskEditorFieldId, delta: number, groupFields: TaskEditorFieldId[]) => {
        const groupOrder = taskEditorOrder.filter((id) => groupFields.includes(id));
        const fromIndex = groupOrder.indexOf(fieldId);
        if (fromIndex < 0) return;
        const toIndex = Math.max(0, Math.min(groupOrder.length - 1, fromIndex + delta));
        if (fromIndex === toIndex) return;
        const nextGroupOrder = [...groupOrder];
        const [item] = nextGroupOrder.splice(fromIndex, 1);
        nextGroupOrder.splice(toIndex, 0, item);
        let groupIndex = 0;
        const nextOrder = taskEditorOrder.map((id) =>
            groupFields.includes(id) ? nextGroupOrder[groupIndex++] : id
        );
        saveTaskEditor({ order: nextOrder, hidden: Array.from(hiddenSet) });
    };

    const updateFieldSection = (fieldId: TaskEditorFieldId, sectionId: TaskEditorSectionId) => {
        if (!isTaskEditorSectionableField(fieldId)) return;
        const nextSections = { ...(settings.gtd?.taskEditor?.sections ?? {}) };
        if (sectionId === DEFAULT_TASK_EDITOR_SECTION_BY_FIELD[fieldId]) {
            delete nextSections[fieldId];
        } else {
            nextSections[fieldId] = sectionId;
        }
        saveTaskEditor({ order: taskEditorOrder, hidden: Array.from(hiddenSet), sections: nextSections });
    };

    const updateSectionOpenDefault = (sectionId: Exclude<TaskEditorSectionId, 'basic'>, isOpen: boolean) => {
        const nextSectionOpen = { ...(settings.gtd?.taskEditor?.sectionOpen ?? {}) };
        if (isOpen === DEFAULT_TASK_EDITOR_SECTION_OPEN[sectionId]) {
            delete nextSectionOpen[sectionId];
        } else {
            nextSectionOpen[sectionId] = isOpen;
        }
        saveTaskEditor({ sectionOpen: nextSectionOpen });
    };

    const fieldGroups: { id: TaskEditorSectionId; title: string; fields: TaskEditorFieldId[] }[] = TASK_EDITOR_SECTION_ORDER.map((sectionId) => ({
        id: sectionId,
        title: sectionLabel(sectionId),
        fields: taskEditorOrder.filter((fieldId) => {
            if (sectionId === 'basic' && TASK_EDITOR_FIXED_FIELDS.includes(fieldId)) return true;
            return isTaskEditorSectionableField(fieldId) && taskEditorSections[fieldId] === sectionId;
        }),
    }));

    const selectedFieldId = taskEditorSelectedField;
    const selectedFieldGroup = selectedFieldId
        ? fieldGroups.find((group) => group.fields.includes(selectedFieldId)) ?? null
        : null;
    const selectedFieldGroupFields = selectedFieldGroup?.fields ?? [];
    const selectedFieldGroupOrder = taskEditorOrder.filter((id) => selectedFieldGroupFields.includes(id));
    const selectedFieldIndex = selectedFieldId ? selectedFieldGroupOrder.indexOf(selectedFieldId) : -1;
    const selectedFieldSectionable = selectedFieldId ? isTaskEditorSectionableField(selectedFieldId) : false;
    const selectedFieldVisible = selectedFieldId ? !hiddenSet.has(selectedFieldId) : false;

    function TaskEditorFieldRow({
        fieldId,
        isFirst,
        showTopBorder = false,
    }: {
        fieldId: TaskEditorFieldId;
        isFirst: boolean;
        showTopBorder?: boolean;
    }) {
        const visible = !hiddenSet.has(fieldId);

        return (
            <View
                style={[
                    styles.taskEditorCompactRow,
                    { borderTopColor: tc.border },
                    (showTopBorder || !isFirst) && styles.taskEditorCompactRowBorder,
                ]}
            >
                <TouchableOpacity
                    testID={`task-editor-visibility-${fieldId}`}
                    accessibilityRole="button"
                    accessibilityLabel={`${visible ? hideInEditorLabel : showInEditorLabel}: ${fieldLabel(fieldId)}`}
                    accessibilityState={{ selected: visible }}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    onPress={() => toggleFieldVisibility(fieldId)}
                    activeOpacity={0.8}
                >
                    <View
                        style={[
                            styles.taskEditorVisibilityBadge,
                            {
                                backgroundColor: visible ? tc.filterBg : 'transparent',
                                borderColor: visible ? tc.tint : tc.border,
                            },
                        ]}
                    >
                        <Ionicons
                            name={visible ? 'eye-outline' : 'eye-off-outline'}
                            size={16}
                            color={visible ? tc.tint : tc.secondaryText}
                        />
                    </View>
                </TouchableOpacity>
                <TouchableOpacity
                    testID={`task-editor-row-${fieldId}`}
                    style={styles.taskEditorCompactRowMain}
                    onPress={() => setTaskEditorSelectedField(fieldId)}
                    activeOpacity={0.8}
                >
                    <View style={styles.settingInfo}>
                        <Text style={[styles.settingLabel, { color: tc.text }]}>{fieldLabel(fieldId)}</Text>
                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                            {visible ? t('settings.visible') : t('settings.hidden')}
                        </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color={tc.secondaryText} />
                </TouchableOpacity>
            </View>
        );
    }

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
            <SettingsTopBar title={t('settings.taskEditorLayout')} />
            <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                <Text style={[styles.description, { color: tc.secondaryText }]}>{t('settings.taskEditorLayoutDesc')}</Text>
                <Text style={[styles.description, { color: tc.secondaryText, marginTop: -6 }]}>{taskEditorHelperText}</Text>

                <View style={[styles.settingCard, { backgroundColor: tc.cardBg, overflow: 'visible' }]}>
                    <Text style={[styles.sectionHeaderText, { color: tc.secondaryText }]}>{taskEditorPresetLabel}</Text>
                    <View style={styles.taskEditorPresetRow}>
                        {taskEditorPresetOptions.map((option) => {
                            const selected = activeTaskEditorPreset === option.id;
                            return (
                                <TouchableOpacity
                                    key={option.id}
                                    style={[
                                        styles.taskEditorPresetButton,
                                        {
                                            backgroundColor: selected ? tc.filterBg : 'transparent',
                                            borderColor: selected ? tc.tint : tc.border,
                                        },
                                    ]}
                                    onPress={() => {
                                        const preset = buildTaskEditorPresetConfig(option.id, featureHiddenFields);
                                        saveTaskEditor(preset);
                                    }}
                                >
                                    <CompactText
                                        style={[styles.taskEditorPresetButtonText, { color: selected ? tc.tint : tc.secondaryText }]}
                                        numberOfLines={1}
                                    >
                                        {option.label}
                                    </CompactText>
                                </TouchableOpacity>
                            );
                        })}
                    </View>
                    {activeTaskEditorPreset === 'custom' && (
                        <Text style={[styles.settingDescription, { color: tc.secondaryText, paddingHorizontal: 16, paddingBottom: 16 }]}>
                            {taskEditorCustomLabel}
                        </Text>
                    )}
                </View>

                {fieldGroups.map((group) => {
                    const groupOrder = taskEditorOrder.filter((id) => group.fields.includes(id));
                    if (groupOrder.length === 0) return null;
                    const expanded = taskEditorExpandedSections[group.id];
                    return (
                        <View key={group.id} style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                            <TouchableOpacity
                                style={styles.taskEditorSectionHeaderRow}
                                onPress={() => setTaskEditorExpandedSections((prev) => ({ ...prev, [group.id]: !prev[group.id] }))}
                                activeOpacity={0.8}
                            >
                                <View style={styles.taskEditorSectionHeaderMain}>
                                    <CompactText
                                        style={[styles.settingLabel, { color: tc.text }]}
                                        numberOfLines={2}
                                    >
                                        {group.title}
                                    </CompactText>
                                    <View style={[styles.taskEditorSectionCountBadge, { backgroundColor: tc.filterBg }]}>
                                        <Text style={[styles.taskEditorSectionCountText, { color: tc.tint }]}>{groupOrder.length}</Text>
                                    </View>
                                </View>
                                <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color={tc.secondaryText} />
                            </TouchableOpacity>
                            {expanded && (
                                <>
                                    {group.id !== 'basic' && (
                                        <SettingToggleRow
                                            divider
                                            label={resolvedTaskEditorDefaultOpenLabel}
                                            description={taskEditorKeepOpenLabel}
                                            value={taskEditorSectionOpen[group.id]}
                                            onChange={(value) => updateSectionOpenDefault(group.id as Exclude<TaskEditorSectionId, 'basic'>, value)}
                                        />
                                    )}
                                    {groupOrder.map((fieldId, index) => (
                                        <TaskEditorFieldRow
                                            key={fieldId}
                                            fieldId={fieldId}
                                            isFirst={index === 0}
                                            showTopBorder={group.id !== 'basic' && index === 0}
                                        />
                                    ))}
                                </>
                            )}
                        </View>
                    );
                })}

                <TouchableOpacity
                    style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}
                    onPress={() => {
                        const nextFeatures = { ...(settings.features ?? {}) };
                        nextFeatures.priorities = !defaultTaskEditorHidden.includes('priority');
                        nextFeatures.timeEstimates = !defaultTaskEditorHidden.includes('timeEstimate');
                        saveTaskEditor(
                            {
                                order: [...defaultTaskEditorOrder],
                                hidden: [...defaultTaskEditorHidden],
                                sections: {},
                                sectionOpen: {},
                            },
                            nextFeatures
                        );
                    }}
                >
                    <View style={styles.settingRow}>
                        <CompactText
                            style={[styles.settingLabel, { color: tc.text }]}
                            numberOfLines={2}
                        >
                            {t('settings.resetToDefault')}
                        </CompactText>
                    </View>
                </TouchableOpacity>
            </ScrollView>

            <Modal
                visible={Boolean(selectedFieldId)}
                transparent
                animationType="slide"
                onRequestClose={() => setTaskEditorSelectedField(null)}
            >
                <View style={styles.taskEditorSheetOverlay}>
                    <Pressable style={StyleSheet.absoluteFill} onPress={() => setTaskEditorSelectedField(null)} />
                    <View
                        style={[
                            styles.taskEditorSheetCard,
                            {
                                backgroundColor: tc.cardBg,
                                borderColor: tc.border,
                                paddingBottom: 16 + Math.max(insets.bottom, 8),
                            },
                        ]}
                    >
                        <View style={[styles.taskEditorSheetHandle, { backgroundColor: tc.border }]} />
                        {selectedFieldId && (
                            <>
                                <View style={styles.settingRowColumn}>
                                    <Text style={[styles.pickerTitle, { color: tc.text, marginBottom: 4 }]}>{fieldLabel(selectedFieldId)}</Text>
                                    {selectedFieldGroup && (
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{selectedFieldGroup.title}</Text>
                                    )}
                                </View>

                                <SettingToggleRow
                                    divider
                                    label={showInEditorLabel}
                                    value={selectedFieldVisible}
                                    onChange={() => toggleFieldVisibility(selectedFieldId)}
                                />

                                {selectedFieldSectionable && (
                                    <View style={[styles.settingRowColumn, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                        <Text style={[styles.settingLabel, { color: tc.text }]}>{taskEditorMoveSectionLabel}</Text>
                                        <View style={styles.taskEditorSectionChips}>
                                            {TASK_EDITOR_SECTION_ORDER.map((sectionId) => {
                                                const selected = taskEditorSections[selectedFieldId] === sectionId;
                                                return (
                                                    <TouchableOpacity
                                                        key={sectionId}
                                                        style={[
                                                            styles.taskEditorSectionChip,
                                                            {
                                                                borderColor: selected ? tc.tint : tc.border,
                                                                backgroundColor: selected ? tc.filterBg : 'transparent',
                                                            },
                                                        ]}
                                                        onPress={() => updateFieldSection(selectedFieldId, sectionId)}
                                                    >
                                                        <Text style={[styles.taskEditorSectionChipText, { color: selected ? tc.tint : tc.secondaryText }]}>
                                                            {sectionLabel(sectionId)}
                                                        </Text>
                                                    </TouchableOpacity>
                                                );
                                            })}
                                        </View>
                                    </View>
                                )}

                                <View style={[styles.settingRowColumn, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>{taskEditorOrderLabel}</Text>
                                    <View style={styles.taskEditorSheetActions}>
                                        <TouchableOpacity
                                            style={[
                                                styles.taskEditorSheetActionButton,
                                                { borderColor: tc.border, backgroundColor: tc.filterBg },
                                                selectedFieldIndex <= 0 && styles.taskEditorSheetActionDisabled,
                                            ]}
                                            onPress={() => moveOrderInGroup(selectedFieldId, -1, selectedFieldGroupFields)}
                                            disabled={selectedFieldIndex <= 0}
                                        >
                                            <Ionicons name="arrow-up" size={16} color={selectedFieldIndex <= 0 ? tc.secondaryText : tc.text} />
                                            <Text style={[styles.taskEditorSheetActionText, { color: selectedFieldIndex <= 0 ? tc.secondaryText : tc.text }]}>
                                                {moveUpLabel}
                                            </Text>
                                        </TouchableOpacity>
                                        <TouchableOpacity
                                            style={[
                                                styles.taskEditorSheetActionButton,
                                                { borderColor: tc.border, backgroundColor: tc.filterBg },
                                                selectedFieldIndex >= selectedFieldGroupOrder.length - 1 && styles.taskEditorSheetActionDisabled,
                                            ]}
                                            onPress={() => moveOrderInGroup(selectedFieldId, 1, selectedFieldGroupFields)}
                                            disabled={selectedFieldIndex >= selectedFieldGroupOrder.length - 1}
                                        >
                                            <Ionicons
                                                name="arrow-down"
                                                size={16}
                                                color={selectedFieldIndex >= selectedFieldGroupOrder.length - 1 ? tc.secondaryText : tc.text}
                                            />
                                            <Text
                                                style={[
                                                    styles.taskEditorSheetActionText,
                                                    { color: selectedFieldIndex >= selectedFieldGroupOrder.length - 1 ? tc.secondaryText : tc.text },
                                                ]}
                                            >
                                                {moveDownLabel}
                                            </Text>
                                        </TouchableOpacity>
                                    </View>
                                </View>

                                <TouchableOpacity
                                    style={[styles.taskEditorSheetDoneButton, { backgroundColor: filledButton.backgroundColor }]}
                                    onPress={() => setTaskEditorSelectedField(null)}
                                >
                                    <Text style={[styles.taskEditorSheetDoneButtonText, { color: filledButton.textColor ?? tc.onTint }]}>{doneLabel}</Text>
                                </TouchableOpacity>
                            </>
                        )}
                    </View>
                </View>
            </Modal>
        </SafeAreaView>
    );
}
