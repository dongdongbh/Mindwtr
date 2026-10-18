import React, { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Check } from 'lucide-react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { useThemeColors } from '@/hooks/use-theme-colors';
import { useFilledButtonColors } from '@/hooks/use-filled-button-colors';
import { CompactText } from '@/components/compact-text';
import { dispatchMobileOnboardingEvent } from '@/lib/mobile-onboarding-events';
import { logSettingsError } from '@/lib/settings-utils';
import { useToast } from '@/contexts/toast-context';
import {
    updateSettingsFromLatest,
    DEFAULT_TASK_EDITOR_SECTION_OPEN,
    buildGtdSettingsModel,
    buildGtdSettingsUpdate,
    isGtdSettingStored,
    normalizeClockTimeInput,
    resolveGtdPomodoroDurations,
    shallow,
    type GtdSettingsEdit,
    type GtdTaskEditorField,
    type TaskEditorFieldId,
    type TaskEditorSectionId,
    useTaskStore,
} from '@mindwtr/core';

import { ExactAlarmNoticeRow, useExactAlarmPermission } from './exact-alarm-notice';
import { AndroidCaptureIntentSection } from './android-capture-intent-section';
import { SettingRow, SettingToggleRow } from './setting-row';
import type { SettingsScreen } from './settings.constants';
import { useSettingsLocalization, useSettingsScrollContent } from './settings.hooks';
import { SettingsTopBar } from './settings.shell';
import { styles } from './settings.styles';
import { useTaskOpenMode } from '@/lib/view-state/task-open-mode';

type GtdScreen =
    | 'gtd'
    | 'gtd-archive'
    | 'gtd-capture'
    | 'gtd-inbox'
    | 'gtd-pomodoro'
    | 'gtd-review'
    | 'gtd-task-editor';

const SHOW_TEMP_ONBOARDING_TRIGGER = false;

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
    const { t } = useSettingsLocalization();
    const { showToast } = useToast();
    const { mode: taskOpenMode, setMode: setTaskOpenMode } = useTaskOpenMode();
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

    // Every row's text, value, visibility and write comes from core's GTD model,
    // shared with the native host.
    const model = buildGtdSettingsModel({ settings, areas, taskOpenMode, t });
    const { hub, capture, review, inbox, archive } = model;
    const pomodoroModel = model.pomodoro;
    const pomodoroEnabled = hub.pomodoro.value;
    const pomodoroCompletionAlert = pomodoroModel.controls?.completionAlert.value ?? false;
    const defaultScheduleTime = hub.defaultScheduleTime.value;
    const { showNotice: showExactAlarmNotice } = useExactAlarmPermission(
        screen === 'gtd-pomodoro' && pomodoroEnabled && pomodoroCompletionAlert
    );
    const [pomodoroFocusDraft, setPomodoroFocusDraft] = useState(pomodoroModel.minutes.focus);
    const [pomodoroBreakDraft, setPomodoroBreakDraft] = useState(pomodoroModel.minutes.break);
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
        setPomodoroFocusDraft(pomodoroModel.minutes.focus);
        setPomodoroBreakDraft(pomodoroModel.minutes.break);
    }, [pomodoroModel.minutes.break, pomodoroModel.minutes.focus]);

    useEffect(() => {
        setDefaultScheduleTimeDraft(defaultScheduleTime);
    }, [defaultScheduleTime]);

    // Re-picking the stored value writes nothing, as the native host's contract:
    // a repeat write saves the whole document again for no change.
    // The group is rebuilt from the latest stored settings, so a key another device changed stays.
    const writeSetting = (edit: GtdSettingsEdit, afterWrite?: () => void) => {
        updateSettingsFromLatest((latest) => (
            isGtdSettingStored(latest, edit) ? null : buildGtdSettingsUpdate(latest, edit)
        ), { write: updateSettings, read: () => useTaskStore.getState().settings }).then((wrote) => { if (wrote) afterWrite?.(); }).catch(logSettingsError);
    };

    const showPomodoroAutoStartNotice = () => {
        if (pomodoroAutoStartNoticeShownRef.current) return;
        pomodoroAutoStartNoticeShownRef.current = true;
        showToast({
            message: pomodoroModel.autoStartNotice,
            tone: 'info',
            durationMs: 5000,
        });
    };

    const commitDefaultScheduleTime = () => {
        const normalized = normalizeClockTimeInput(defaultScheduleTimeDraft);
        if (normalized === null) {
            setDefaultScheduleTimeDraft(defaultScheduleTime);
            showToast({
                message: hub.defaultScheduleTime.invalidMessage,
                tone: 'warning',
            });
            return;
        }
        setDefaultScheduleTimeDraft(normalized);
        writeSetting({ type: 'defaultScheduleTime', value: normalized });
    };

    const commitPomodoroMinutes = () => {
        const nextDurations = resolveGtdPomodoroDurations(settings, pomodoroFocusDraft, pomodoroBreakDraft);
        writeSetting({ type: 'pomodoroDurations', focusMinutes: pomodoroFocusDraft, breakMinutes: pomodoroBreakDraft });
        setPomodoroFocusDraft(String(nextDurations.focusMinutes));
        setPomodoroBreakDraft(String(nextDurations.breakMinutes));
    };

    const selectDefaultArea = (edit: GtdSettingsEdit) => {
        writeSetting(edit);
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
                <SettingsTopBar title={hub.title} />
                <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                    <Text style={[styles.description, { color: tc.secondaryText }]}>{hub.description}</Text>
                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginBottom: 12 }]}>
                        <SettingRow
                            label={hub.features.label}
                            description={hub.features.description}
                        />
                        <SettingToggleRow
                            divider
                            label={hub.pomodoro.label}
                            description={hub.pomodoro.description ?? undefined}
                            value={hub.pomodoro.value}
                            onChange={() => writeSetting(hub.pomodoro.edit)}
                        />
                        {hub.pomodoroSettings && renderGtdNavigationRow(
                            hub.pomodoroSettings.title,
                            hub.pomodoroSettings.description,
                            hub.pomodoroSettings.screen,
                            { testID: 'gtd-nav-pomodoro' }
                        )}
                    </View>

                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                        <SettingRow
                            label={hub.defaultScheduleTime.label}
                            description={hub.defaultScheduleTime.description}
                        >
                            <TextInput
                                value={defaultScheduleTimeDraft}
                                onChangeText={setDefaultScheduleTimeDraft}
                                onBlur={commitDefaultScheduleTime}
                                placeholder={hub.defaultScheduleTime.placeholder}
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
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{hub.focusTaskLimit.label}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{hub.focusTaskLimit.description}</Text>
                            </View>
                            <View style={[styles.gtdSegmentedControl, { backgroundColor: tc.bg, borderColor: tc.border }]}>
                                {hub.focusTaskLimit.options.map((option) => {
                                    const selected = option.selected;
                                    return (
                                        <TouchableOpacity
                                            key={option.value}
                                            accessibilityRole="button"
                                            accessibilityState={{ selected }}
                                            style={[
                                                styles.gtdSegmentedOption,
                                                { backgroundColor: selected ? tc.filterBg : 'transparent' },
                                            ]}
                                            onPress={() => writeSetting(option.edit)}
                                            activeOpacity={0.8}
                                        >
                                            <CompactText
                                                style={[styles.gtdSegmentedOptionText, { color: selected ? tc.tint : tc.secondaryText }]}
                                                numberOfLines={2}
                                            >
                                                {option.value}
                                            </CompactText>
                                        </TouchableOpacity>
                                    );
                                })}
                            </View>
                        </View>
                        <SettingToggleRow
                            divider
                            label={hub.focusIncludeStartDates.label}
                            description={hub.focusIncludeStartDates.description ?? undefined}
                            value={hub.focusIncludeStartDates.value}
                            onChange={() => writeSetting(hub.focusIncludeStartDates.edit)}
                        />
                        <View style={[styles.settingRowColumn, { borderTopWidth: 1, borderTopColor: tc.border, gap: 12 }]}>
                            <View>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{hub.defaultProjectFlowMode.label}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{hub.defaultProjectFlowMode.description}</Text>
                            </View>
                            <View style={[styles.gtdSegmentedControl, { backgroundColor: tc.bg, borderColor: tc.border }]}>
                                {hub.defaultProjectFlowMode.options.map((option) => {
                                    const selected = option.selected;
                                    return (
                                        <TouchableOpacity
                                            key={option.value}
                                            accessibilityRole="button"
                                            accessibilityState={{ selected }}
                                            style={[
                                                styles.gtdSegmentedOption,
                                                { backgroundColor: selected ? tc.filterBg : 'transparent' },
                                            ]}
                                            onPress={() => writeSetting(option.edit)}
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
                        {renderGtdNavigationRow(
                            hub.autoArchive.title,
                            hub.autoArchive.description,
                            hub.autoArchive.screen,
                            { testID: 'gtd-nav-archive' }
                        )}
                    </View>

                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                        {renderGtdNavigationRow(
                            hub.taskEditor.title,
                            hub.taskEditor.description,
                            hub.taskEditor.screen,
                            { first: true, testID: 'gtd-nav-task-editor' }
                        )}
                        {renderGtdNavigationRow(
                            hub.capture.title,
                            hub.capture.description,
                            hub.capture.screen,
                            { testID: 'gtd-nav-capture' }
                        )}
                    </View>

                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                        {renderGtdNavigationRow(
                            hub.review.title,
                            hub.review.description,
                            hub.review.screen,
                            { first: true, testID: 'gtd-nav-review' }
                        )}
                        {renderGtdNavigationRow(
                            hub.inbox.title,
                            hub.inbox.description,
                            hub.inbox.screen,
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
        const controls = pomodoroModel.controls;
        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SettingsTopBar title={pomodoroModel.title} />
                <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                    <Text style={[styles.description, { color: tc.secondaryText }]}>{pomodoroModel.description}</Text>
                    {!controls ? (
                        <TouchableOpacity
                            style={[styles.settingCard, { backgroundColor: tc.cardBg }]}
                            accessibilityRole="button"
                            onPress={() => { if (pomodoroModel.enable) writeSetting(pomodoroModel.enable.edit); }}
                            activeOpacity={0.75}
                        >
                            <View style={styles.settingRow}>
                                <Text style={[styles.settingLabel, { color: tc.tint }]}>{pomodoroModel.enable?.label}</Text>
                            </View>
                        </TouchableOpacity>
                    ) : (
                        <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                            <View style={[styles.settingRowColumn, { gap: 12 }]}>
                                <View style={styles.settingInfo}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>{controls.customPreset.label}</Text>
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{controls.customPreset.description}</Text>
                                </View>
                                <View style={styles.inlineInputRow}>
                                    <View style={styles.inlineInputGroup}>
                                        <Text style={[styles.inlineInputLabel, { color: tc.secondaryText }]}>{controls.customPreset.focusLabel}</Text>
                                        <TextInput
                                            value={pomodoroFocusDraft}
                                            onChangeText={setPomodoroFocusDraft}
                                            onBlur={commitPomodoroMinutes}
                                            keyboardType="number-pad"
                                            accessibilityLabel={controls.customPreset.focusLabel}
                                            style={[styles.textInput, styles.inlineTextInput, { borderColor: tc.border, color: tc.text }]}
                                        />
                                    </View>
                                    <View style={styles.inlineInputGroup}>
                                        <Text style={[styles.inlineInputLabel, { color: tc.secondaryText }]}>{controls.customPreset.breakLabel}</Text>
                                        <TextInput
                                            value={pomodoroBreakDraft}
                                            onChangeText={setPomodoroBreakDraft}
                                            onBlur={commitPomodoroMinutes}
                                            keyboardType="number-pad"
                                            accessibilityLabel={controls.customPreset.breakLabel}
                                            style={[styles.textInput, styles.inlineTextInput, { borderColor: tc.border, color: tc.text }]}
                                        />
                                    </View>
                                </View>
                            </View>
                            <SettingToggleRow
                                divider
                                label={controls.linkTask.label}
                                description={controls.linkTask.description ?? undefined}
                                value={controls.linkTask.value}
                                onChange={() => writeSetting(controls.linkTask.edit)}
                            />
                            <SettingToggleRow
                                divider
                                label={controls.autoStartBreaks.label}
                                description={controls.autoStartBreaks.description ?? undefined}
                                value={controls.autoStartBreaks.value}
                                onChange={() => writeSetting(
                                    controls.autoStartBreaks.edit,
                                    controls.autoStartBreaks.value ? undefined : showPomodoroAutoStartNotice
                                )}
                            />
                            <SettingToggleRow
                                divider
                                label={controls.autoStartFocus.label}
                                description={controls.autoStartFocus.description ?? undefined}
                                value={controls.autoStartFocus.value}
                                onChange={() => writeSetting(
                                    controls.autoStartFocus.edit,
                                    controls.autoStartFocus.value ? undefined : showPomodoroAutoStartNotice
                                )}
                            />
                            <SettingToggleRow
                                divider
                                label={controls.completionAlert.label}
                                description={controls.completionAlert.description ?? undefined}
                                value={controls.completionAlert.value}
                                switchTestID="pomodoro-completion-alert"
                                onChange={() => writeSetting(controls.completionAlert.edit)}
                            />
                            {showExactAlarmNotice && controls.alarmNotice && (
                                <ExactAlarmNoticeRow
                                    inline
                                    label={controls.alarmNotice.label}
                                    description={controls.alarmNotice.description}
                                    actionLabel={controls.alarmNotice.actionLabel}
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
                <SettingsTopBar title={capture.title} />
                <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                    <Text style={[styles.description, { color: tc.secondaryText }]}>{capture.description}</Text>
                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                        <SettingRow
                            label={capture.method.label}
                            description={capture.method.description}
                        />
                        <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                            <View style={[styles.gtdSegmentedControl, { backgroundColor: tc.bg, borderColor: tc.border }]}>
                                {capture.method.options.map((option) => {
                                    const selected = option.selected;
                                    return (
                                        <TouchableOpacity
                                            key={option.value}
                                            accessibilityRole="button"
                                            accessibilityState={{ selected }}
                                            style={[
                                                styles.gtdSegmentedOption,
                                                { backgroundColor: selected ? tc.filterBg : 'transparent' },
                                            ]}
                                            onPress={() => writeSetting(option.edit)}
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
                            accessibilityLabel={capture.defaultArea.accessibilityLabel}
                            onPress={() => setDefaultAreaPickerVisible(true)}
                            activeOpacity={0.75}
                        >
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{capture.defaultArea.label}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{capture.defaultArea.description}</Text>
                            </View>
                            <View style={[styles.menuRight, { flexShrink: 1, maxWidth: '42%' }]}>
                            <CompactText
                                style={[styles.settingValue, { color: tc.secondaryText }]}
                                numberOfLines={2}
                            >
                                {capture.defaultArea.value}
                            </CompactText>
                                <Ionicons name="chevron-forward" size={18} color={tc.secondaryText} />
                            </View>
                        </TouchableOpacity>
                        {capture.saveAudio ? (
                            <SettingToggleRow
                                divider
                                label={capture.saveAudio.label}
                                description={capture.saveAudio.description ?? undefined}
                                value={capture.saveAudio.value}
                                onChange={() => writeSetting(capture.saveAudio!.edit)}
                            />
                        ) : null}
                        <SettingToggleRow
                            divider
                            label={capture.quickAddAutoClean.label}
                            description={capture.quickAddAutoClean.description ?? undefined}
                            value={capture.quickAddAutoClean.value}
                            onChange={() => writeSetting(capture.quickAddAutoClean.edit)}
                        />
                        <SettingToggleRow
                            divider
                            label={capture.naturalLanguageDates.label}
                            description={capture.naturalLanguageDates.description ?? undefined}
                            value={capture.naturalLanguageDates.value}
                            onChange={() => writeSetting(capture.naturalLanguageDates.edit)}
                        />
                        <SettingToggleRow
                            divider
                            label={capture.markdownEditorAssist.label}
                            description={capture.markdownEditorAssist.description ?? undefined}
                            value={capture.markdownEditorAssist.value}
                            onChange={() => writeSetting(capture.markdownEditorAssist.edit)}
                        />
                    </View>
                    <AndroidCaptureIntentSection />
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
                            <Text style={[styles.pickerTitle, { color: tc.text }]}>{capture.defaultArea.pickerTitle}</Text>
                            <ScrollView style={styles.pickerList} contentContainerStyle={styles.pickerListContent}>
                                {capture.defaultArea.options.map((option) => {
                                    const selected = option.selected;
                                    return (
                                        <TouchableOpacity
                                            key={option.value || 'none'}
                                            testID={`default-area-picker-option-${option.value || 'none'}`}
                                            accessibilityRole="button"
                                            accessibilityState={{ selected }}
                                            style={[
                                                styles.pickerOption,
                                                {
                                                    backgroundColor: selected ? tc.filterBg : 'transparent',
                                                    borderColor: selected ? tc.tint : tc.border,
                                                },
                                            ]}
                                            onPress={() => selectDefaultArea(option.edit)}
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
                <SettingsTopBar title={review.title} />
                <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                    <Text style={[styles.description, { color: tc.secondaryText }]}>
                        {review.description}
                    </Text>
                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                        <SettingRow
                            label={review.daily.label}
                            description={review.daily.description}
                        />
                        <SettingToggleRow
                            divider
                            label={review.dailyFocusStep.label}
                            description={review.dailyFocusStep.description ?? undefined}
                            value={review.dailyFocusStep.value}
                            onChange={() => writeSetting(review.dailyFocusStep.edit)}
                        />
                        <SettingRow
                            divider
                            label={review.weekly.label}
                            description={review.weekly.description}
                        />
                        <SettingToggleRow
                            divider
                            label={review.weeklyContextStep.label}
                            description={review.weeklyContextStep.description ?? undefined}
                            value={review.weeklyContextStep.value}
                            onChange={() => writeSetting(review.weeklyContextStep.edit)}
                        />
                    </View>
                </ScrollView>
            </SafeAreaView>
        );
    }

    if (screen === 'gtd-inbox') {
        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SettingsTopBar title={inbox.title} />
                <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                    <Text style={[styles.description, { color: tc.secondaryText }]}>{inbox.description}</Text>
                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                        <SettingToggleRow
                            label={inbox.twoMinute.label}
                            value={inbox.twoMinute.value}
                            onChange={() => writeSetting(inbox.twoMinute.edit)}
                        />
                        <SettingToggleRow
                            divider
                            label={inbox.projectFirst.label}
                            value={inbox.projectFirst.value}
                            onChange={() => writeSetting(inbox.projectFirst.edit)}
                        />
                        <SettingToggleRow
                            divider
                            label={inbox.contextStep.label}
                            value={inbox.contextStep.value}
                            onChange={() => writeSetting(inbox.contextStep.edit)}
                        />
                        <SettingToggleRow
                            divider
                            label={inbox.schedule.label}
                            value={inbox.schedule.value}
                            onChange={() => writeSetting(inbox.schedule.edit)}
                        />
                    </View>
                </ScrollView>
            </SafeAreaView>
        );
    }

    if (screen === 'gtd-archive') {
        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SettingsTopBar title={archive.title} />
                <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                    <Text style={[styles.description, { color: tc.secondaryText }]}>{archive.description}</Text>
                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                        {archive.options.map((option, idx) => (
                            <TouchableOpacity
                                key={option.value}
                                accessibilityRole="radio"
                                accessibilityState={{ selected: option.selected }}
                                style={[styles.settingRow, idx > 0 && { borderTopWidth: 1, borderTopColor: tc.border }]}
                                onPress={() => writeSetting(option.edit)}
                            >
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{option.label}</Text>
                                {option.selected && <Check size={20} color="#3B82F6" strokeWidth={2.5} />}
                            </TouchableOpacity>
                        ))}
                    </View>
                </ScrollView>
            </SafeAreaView>
        );
    }

    if (screen !== 'gtd-task-editor') {
        throw new Error(`Unhandled GTD settings screen: ${screen}`);
    }

    const taskEditor = model.taskEditor;
    const fieldGroups = taskEditor.groups;
    const selectedField = fieldGroups.flatMap((group) => group.fields).find((field) => field.id === taskEditorSelectedField) ?? null;

    function TaskEditorFieldRow({
        field,
        isFirst,
        showTopBorder = false,
    }: {
        field: GtdTaskEditorField;
        isFirst: boolean;
        showTopBorder?: boolean;
    }) {
        const visible = field.visible;

        return (
            <View
                style={[
                    styles.taskEditorCompactRow,
                    { borderTopColor: tc.border },
                    (showTopBorder || !isFirst) && styles.taskEditorCompactRowBorder,
                ]}
            >
                <TouchableOpacity
                    testID={`task-editor-visibility-${field.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={field.visibility.accessibilityLabel}
                    accessibilityState={{ selected: visible }}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    onPress={() => writeSetting(field.visibility.edit)}
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
                    testID={`task-editor-row-${field.id}`}
                    style={styles.taskEditorCompactRowMain}
                    onPress={() => setTaskEditorSelectedField(field.id)}
                    activeOpacity={0.8}
                >
                    <View style={styles.settingInfo}>
                        <Text style={[styles.settingLabel, { color: tc.text }]}>{field.label}</Text>
                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                            {field.status}
                        </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color={tc.secondaryText} />
                </TouchableOpacity>
            </View>
        );
    }

    const moveUp = selectedField?.sheet.order.moveUp;
    const moveDown = selectedField?.sheet.order.moveDown;

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
            <SettingsTopBar title={taskEditor.title} />
            <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                <Text style={[styles.description, { color: tc.secondaryText }]}>{taskEditor.description}</Text>
                <Text style={[styles.description, { color: tc.secondaryText, marginTop: -6 }]}>{taskEditor.helper}</Text>

                <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                    <View style={[styles.settingRowColumn, { gap: 12 }]}>
                        <View>
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{taskEditor.openMode.label}</Text>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{taskEditor.openMode.description}</Text>
                        </View>
                        <View style={[styles.gtdSegmentedControl, { backgroundColor: tc.bg, borderColor: tc.border }]}>
                            {taskEditor.openMode.options.map((option) => {
                                const selected = option.selected;
                                return (
                                    <TouchableOpacity
                                        key={option.value}
                                        testID={`task-open-mode-${option.value}`}
                                        accessibilityRole="radio"
                                        accessibilityState={{ selected }}
                                        style={[
                                            styles.gtdSegmentedOption,
                                            { backgroundColor: selected ? tc.filterBg : 'transparent' },
                                        ]}
                                        onPress={() => setTaskOpenMode(option.value)}
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
                </View>

                <View style={[styles.settingCard, { backgroundColor: tc.cardBg, overflow: 'visible' }]}>
                    <Text style={[styles.sectionHeaderText, { color: tc.secondaryText }]}>{taskEditor.presets.label}</Text>
                    <View style={styles.taskEditorPresetRow}>
                        {taskEditor.presets.options.map((option) => {
                            const selected = option.selected;
                            return (
                                <TouchableOpacity
                                    key={option.value}
                                    accessibilityRole="radio"
                                    accessibilityState={{ selected }}
                                    style={[
                                        styles.taskEditorPresetButton,
                                        {
                                            backgroundColor: selected ? tc.filterBg : 'transparent',
                                            borderColor: selected ? tc.tint : tc.border,
                                        },
                                    ]}
                                    onPress={() => writeSetting(option.edit)}
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
                    {taskEditor.presets.custom !== null && (
                        <Text style={[styles.settingDescription, { color: tc.secondaryText, paddingHorizontal: 16, paddingBottom: 16 }]}>
                            {taskEditor.presets.custom}
                        </Text>
                    )}
                </View>

                {fieldGroups.map((group) => {
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
                                        <Text style={[styles.taskEditorSectionCountText, { color: tc.tint }]}>{group.count}</Text>
                                    </View>
                                </View>
                                <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color={tc.secondaryText} />
                            </TouchableOpacity>
                            {expanded && (
                                <>
                                    {group.defaultOpen && (
                                        <SettingToggleRow
                                            divider
                                            label={group.defaultOpen.label}
                                            description={group.defaultOpen.description ?? undefined}
                                            value={group.defaultOpen.value}
                                            onChange={() => writeSetting(group.defaultOpen!.edit)}
                                        />
                                    )}
                                    {group.fields.map((field, index) => (
                                        <TaskEditorFieldRow
                                            key={field.id}
                                            field={field}
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
                    onPress={() => writeSetting(taskEditor.reset.edit)}
                >
                    <View style={styles.settingRow}>
                        <CompactText
                            style={[styles.settingLabel, { color: tc.text }]}
                            numberOfLines={2}
                        >
                            {taskEditor.reset.label}
                        </CompactText>
                    </View>
                </TouchableOpacity>
            </ScrollView>

            <Modal
                visible={Boolean(taskEditorSelectedField)}
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
                        {selectedField && moveUp && moveDown && (
                            <>
                                <View style={styles.settingRowColumn}>
                                    <Text style={[styles.pickerTitle, { color: tc.text, marginBottom: 4 }]}>{selectedField.sheet.title}</Text>
                                    {selectedField.sheet.section !== null && (
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{selectedField.sheet.section}</Text>
                                    )}
                                </View>

                                <SettingToggleRow
                                    divider
                                    label={selectedField.sheet.visible.label}
                                    value={selectedField.sheet.visible.value}
                                    onChange={() => writeSetting(selectedField.sheet.visible.edit)}
                                />

                                {selectedField.sheet.sections && (
                                    <View style={[styles.settingRowColumn, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                        <Text style={[styles.settingLabel, { color: tc.text }]}>{selectedField.sheet.sections.label}</Text>
                                        <View style={styles.taskEditorSectionChips}>
                                            {selectedField.sheet.sections.options.map((option) => {
                                                const selected = option.selected;
                                                return (
                                                    <TouchableOpacity
                                                        key={option.value}
                                                        style={[
                                                            styles.taskEditorSectionChip,
                                                            {
                                                                borderColor: selected ? tc.tint : tc.border,
                                                                backgroundColor: selected ? tc.filterBg : 'transparent',
                                                            },
                                                        ]}
                                                        onPress={() => writeSetting(option.edit)}
                                                    >
                                                        <Text style={[styles.taskEditorSectionChipText, { color: selected ? tc.tint : tc.secondaryText }]}>
                                                            {option.label}
                                                        </Text>
                                                    </TouchableOpacity>
                                                );
                                            })}
                                        </View>
                                    </View>
                                )}

                                <View style={[styles.settingRowColumn, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>{selectedField.sheet.order.label}</Text>
                                    <View style={styles.taskEditorSheetActions}>
                                        <TouchableOpacity
                                            style={[
                                                styles.taskEditorSheetActionButton,
                                                { borderColor: tc.border, backgroundColor: tc.filterBg },
                                                moveUp.disabled && styles.taskEditorSheetActionDisabled,
                                            ]}
                                            onPress={() => { if (moveUp.edit) writeSetting(moveUp.edit); }}
                                            disabled={moveUp.disabled}
                                        >
                                            <Ionicons name="arrow-up" size={16} color={moveUp.disabled ? tc.secondaryText : tc.text} />
                                            <Text style={[styles.taskEditorSheetActionText, { color: moveUp.disabled ? tc.secondaryText : tc.text }]}>
                                                {moveUp.label}
                                            </Text>
                                        </TouchableOpacity>
                                        <TouchableOpacity
                                            style={[
                                                styles.taskEditorSheetActionButton,
                                                { borderColor: tc.border, backgroundColor: tc.filterBg },
                                                moveDown.disabled && styles.taskEditorSheetActionDisabled,
                                            ]}
                                            onPress={() => { if (moveDown.edit) writeSetting(moveDown.edit); }}
                                            disabled={moveDown.disabled}
                                        >
                                            <Ionicons
                                                name="arrow-down"
                                                size={16}
                                                color={moveDown.disabled ? tc.secondaryText : tc.text}
                                            />
                                            <Text
                                                style={[
                                                    styles.taskEditorSheetActionText,
                                                    { color: moveDown.disabled ? tc.secondaryText : tc.text },
                                                ]}
                                            >
                                                {moveDown.label}
                                            </Text>
                                        </TouchableOpacity>
                                    </View>
                                </View>

                                <TouchableOpacity
                                    style={[styles.taskEditorSheetDoneButton, { backgroundColor: filledButton.backgroundColor }]}
                                    onPress={() => setTaskEditorSelectedField(null)}
                                >
                                    <Text style={[styles.taskEditorSheetDoneButtonText, { color: filledButton.textColor ?? tc.onTint }]}>{selectedField.sheet.doneLabel}</Text>
                                </TouchableOpacity>
                            </>
                        )}
                    </View>
                </View>
            </Modal>
        </SafeAreaView>
    );
}
