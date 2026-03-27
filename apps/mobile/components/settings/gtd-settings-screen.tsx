import React, { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
    buildTaskEditorPresetConfig,
    DEFAULT_TASK_EDITOR_ORDER,
    DEFAULT_TASK_EDITOR_SECTION_BY_FIELD,
    DEFAULT_TASK_EDITOR_SECTION_OPEN,
    DEFAULT_TASK_EDITOR_VISIBLE,
    TASK_EDITOR_FIXED_FIELDS,
    TASK_EDITOR_SECTION_ORDER,
    getTaskEditorSectionAssignments,
    getTaskEditorSectionOpenDefaults,
    isTaskEditorSectionableField,
    resolveTaskEditorPresetId,
    type TaskEditorPresetId,
} from '@/components/task-edit/task-edit-modal.utils';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { logSettingsError } from '@/lib/settings-utils';
import {
    translateText,
    type AppData,
    type TaskEditorFieldId,
    type TaskEditorSectionId,
    type TimeEstimate,
    useTaskStore,
} from '@mindwtr/core';

import type { SettingsScreen } from './settings.constants';
import { useSettingsLocalization, useSettingsScrollContent } from './settings.hooks';
import { MenuItem, SettingsTopBar, SubHeader } from './settings.shell';
import { styles } from './settings.styles';

type GtdScreen =
    | 'gtd'
    | 'gtd-archive'
    | 'gtd-time-estimates'
    | 'gtd-task-editor';

export function GtdSettingsScreen({
    onNavigate,
    screen,
}: {
    onNavigate: (screen: SettingsScreen) => void;
    screen: GtdScreen;
}) {
    const tc = useThemeColors();
    const insets = useSafeAreaInsets();
    const { isChineseLanguage, language, localize, t } = useSettingsLocalization();
    const { settings, updateSettings } = useTaskStore();
    const scrollContentStyle = useSettingsScrollContent();
    const [gtdInboxProcessingExpanded, setGtdInboxProcessingExpanded] = useState(false);
    const [taskEditorExpandedSections, setTaskEditorExpandedSections] = useState<Record<TaskEditorSectionId, boolean>>({
        basic: true,
        scheduling: false,
        organization: false,
        details: false,
    });
    const [taskEditorSelectedField, setTaskEditorSelectedField] = useState<TaskEditorFieldId | null>(null);

    const defaultTimeEstimatePresets: TimeEstimate[] = ['10min', '30min', '1hr', '2hr', '3hr', '4hr', '4hr+'];
    const timeEstimateOptions: TimeEstimate[] = ['5min', '10min', '15min', '30min', '1hr', '2hr', '3hr', '4hr', '4hr+'];
    const timeEstimatePresets: TimeEstimate[] = (settings.gtd?.timeEstimatePresets?.length
        ? settings.gtd.timeEstimatePresets
        : defaultTimeEstimatePresets) as TimeEstimate[];
    const defaultCaptureMethod = settings.gtd?.defaultCaptureMethod ?? 'text';
    const saveAudioAttachments = settings.gtd?.saveAudioAttachments !== false;
    const inboxProcessing = settings.gtd?.inboxProcessing ?? {};
    const inboxTwoMinuteEnabled = inboxProcessing.twoMinuteEnabled !== false;
    const inboxProjectFirst = inboxProcessing.projectFirst === true;
    const inboxContextStepEnabled = inboxProcessing.contextStepEnabled !== false;
    const inboxScheduleEnabled = inboxProcessing.scheduleEnabled === true;
    const inboxReferenceEnabled = inboxProcessing.referenceEnabled === true;
    const includeContextStep = settings.gtd?.weeklyReview?.includeContextStep !== false;
    const autoArchiveDays = Number.isFinite(settings.gtd?.autoArchiveDays)
        ? Math.max(0, Math.floor(settings.gtd?.autoArchiveDays as number))
        : 7;
    const prioritiesEnabled = settings.features?.priorities === true;
    const timeEstimatesEnabled = settings.features?.timeEstimates === true;
    const pomodoroEnabled = settings.features?.pomodoro === true;

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

    const updateFeatureFlags = (next: { priorities?: boolean; timeEstimates?: boolean; pomodoro?: boolean }) => {
        updateSettings({
            features: {
                ...(settings.features ?? {}),
                ...next,
            },
        }).catch(logSettingsError);
    };

    const updateInboxProcessing = (partial: Partial<NonNullable<NonNullable<AppData['settings']['gtd']>['inboxProcessing']>>) => {
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

    const updateWeeklyReviewConfig = (partial: NonNullable<NonNullable<AppData['settings']['gtd']>['weeklyReview']>) => {
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

    const formatTimeEstimateLabel = (value: TimeEstimate) => {
        if (value === '5min') return '5m';
        if (value === '10min') return '10m';
        if (value === '15min') return '15m';
        if (value === '30min') return '30m';
        if (value === '1hr') return '1h';
        if (value === '2hr') return '2h';
        if (value === '3hr') return '3h';
        if (value === '4hr') return '4h';
        return '4h+';
    };

    if (screen === 'gtd') {
        const featurePomodoroLabelRaw = t('settings.featurePomodoro');
        const featurePomodoroDescRaw = t('settings.featurePomodoroDesc');
        const featurePomodoroLabel = featurePomodoroLabelRaw === 'settings.featurePomodoro'
            ? localize('Pomodoro timer', '番茄钟')
            : featurePomodoroLabelRaw;
        const featurePomodoroDesc = featurePomodoroDescRaw === 'settings.featurePomodoroDesc'
            ? localize('Enable the optional Pomodoro panel in Focus view.', '在聚焦视图中启用可选的番茄钟面板。')
            : featurePomodoroDescRaw;

        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SettingsTopBar />
                <SubHeader title={t('settings.gtd')} />
                <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                    <Text style={[styles.description, { color: tc.secondaryText }]}>{t('settings.gtdDesc')}</Text>
                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginBottom: 12 }]}>
                        <View style={styles.settingRow}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.features')}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.featuresDesc')}</Text>
                            </View>
                        </View>
                        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{featurePomodoroLabel}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{featurePomodoroDesc}</Text>
                            </View>
                            <Switch
                                value={pomodoroEnabled}
                                onValueChange={(value) => updateFeatureFlags({ pomodoro: value })}
                                trackColor={{ false: '#767577', true: '#3B82F6' }}
                            />
                        </View>
                    </View>

                    <View style={[styles.menuCard, { backgroundColor: tc.cardBg }]}>
                        {timeEstimatesEnabled && (
                            <MenuItem title={t('settings.timeEstimatePresets')} onPress={() => onNavigate('gtd-time-estimates')} />
                        )}
                        <MenuItem title={t('settings.autoArchive')} onPress={() => onNavigate('gtd-archive')} />
                        <MenuItem title={t('settings.taskEditorLayout')} onPress={() => onNavigate('gtd-task-editor')} />
                    </View>

                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                        <View style={styles.settingRow}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.captureDefault')}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.captureDefaultDesc')}</Text>
                            </View>
                        </View>
                        <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                            <View style={styles.backendToggle}>
                                <TouchableOpacity
                                    style={[
                                        styles.backendOption,
                                        { borderColor: tc.border, backgroundColor: defaultCaptureMethod === 'text' ? tc.filterBg : 'transparent' },
                                    ]}
                                    onPress={() => {
                                        updateSettings({
                                            gtd: {
                                                ...(settings.gtd ?? {}),
                                                defaultCaptureMethod: 'text',
                                            },
                                        }).catch(logSettingsError);
                                    }}
                                >
                                    <Text style={[styles.backendOptionText, { color: defaultCaptureMethod === 'text' ? tc.tint : tc.secondaryText }]}>
                                        {t('settings.captureDefaultText')}
                                    </Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={[
                                        styles.backendOption,
                                        { borderColor: tc.border, backgroundColor: defaultCaptureMethod === 'audio' ? tc.filterBg : 'transparent' },
                                    ]}
                                    onPress={() => {
                                        updateSettings({
                                            gtd: {
                                                ...(settings.gtd ?? {}),
                                                defaultCaptureMethod: 'audio',
                                            },
                                        }).catch(logSettingsError);
                                    }}
                                >
                                    <Text style={[styles.backendOptionText, { color: defaultCaptureMethod === 'audio' ? tc.tint : tc.secondaryText }]}>
                                        {t('settings.captureDefaultAudio')}
                                    </Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                        {defaultCaptureMethod === 'audio' ? (
                            <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                <View style={styles.settingInfo}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.captureSaveAudio')}</Text>
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.captureSaveAudioDesc')}</Text>
                                </View>
                                <Switch
                                    value={saveAudioAttachments}
                                    onValueChange={(value) => {
                                        updateSettings({
                                            gtd: {
                                                ...(settings.gtd ?? {}),
                                                saveAudioAttachments: value,
                                            },
                                        }).catch(logSettingsError);
                                    }}
                                    trackColor={{ false: '#767577', true: '#3B82F6' }}
                                />
                            </View>
                        ) : null}
                    </View>

                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                        <View style={styles.settingRow}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.weeklyReviewConfig')}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.weeklyReviewConfigDesc')}</Text>
                            </View>
                        </View>
                        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.weeklyReviewIncludeContextsStep')}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {t('settings.weeklyReviewIncludeContextsStepDesc')}
                                </Text>
                            </View>
                            <Switch
                                value={includeContextStep}
                                onValueChange={(value) => updateWeeklyReviewConfig({ includeContextStep: value })}
                                trackColor={{ false: '#767577', true: '#3B82F6' }}
                            />
                        </View>
                    </View>

                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                        <View style={styles.settingRow}>
                            <TouchableOpacity
                                style={styles.settingInfo}
                                onPress={() => setGtdInboxProcessingExpanded((prev) => !prev)}
                                activeOpacity={0.7}
                            >
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.inboxProcessing')}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.inboxProcessingDesc')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity onPress={() => setGtdInboxProcessingExpanded((prev) => !prev)} activeOpacity={0.7}>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {gtdInboxProcessingExpanded ? '▾' : '▸'}
                                </Text>
                            </TouchableOpacity>
                        </View>
                        {gtdInboxProcessingExpanded && (
                            <>
                                <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.inboxTwoMinuteEnabled')}</Text>
                                    </View>
                                    <Switch
                                        value={inboxTwoMinuteEnabled}
                                        onValueChange={(value) => updateInboxProcessing({ twoMinuteEnabled: value })}
                                        trackColor={{ false: '#767577', true: '#3B82F6' }}
                                    />
                                </View>
                                <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.inboxProjectFirst')}</Text>
                                    </View>
                                    <Switch
                                        value={inboxProjectFirst}
                                        onValueChange={(value) => updateInboxProcessing({ projectFirst: value })}
                                        trackColor={{ false: '#767577', true: '#3B82F6' }}
                                    />
                                </View>
                                <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.inboxContextStepEnabled')}</Text>
                                    </View>
                                    <Switch
                                        value={inboxContextStepEnabled}
                                        onValueChange={(value) => updateInboxProcessing({ contextStepEnabled: value })}
                                        trackColor={{ false: '#767577', true: '#3B82F6' }}
                                    />
                                </View>
                                <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.inboxScheduleEnabled')}</Text>
                                    </View>
                                    <Switch
                                        value={inboxScheduleEnabled}
                                        onValueChange={(value) => updateInboxProcessing({ scheduleEnabled: value })}
                                        trackColor={{ false: '#767577', true: '#3B82F6' }}
                                    />
                                </View>
                                <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.inboxReferenceEnabled')}</Text>
                                    </View>
                                    <Switch
                                        value={inboxReferenceEnabled}
                                        onValueChange={(value) => updateInboxProcessing({ referenceEnabled: value })}
                                        trackColor={{ false: '#767577', true: '#3B82F6' }}
                                    />
                                </View>
                            </>
                        )}
                    </View>
                </ScrollView>
            </SafeAreaView>
        );
    }

    if (screen === 'gtd-archive') {
        const autoArchiveOptions = [0, 1, 3, 7, 14, 30, 60];
        const formatAutoArchiveLabel = (days: number) => {
            if (days <= 0) return t('settings.autoArchiveNever');
            return isChineseLanguage ? `${days} 天` : `${days} ${translateText('days', language)}`;
        };

        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SettingsTopBar />
                <SubHeader title={t('settings.autoArchive')} />
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
                    <SettingsTopBar />
                    <SubHeader title={t('settings.timeEstimatePresets')} />
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
                <SettingsTopBar />
                <SubHeader title={t('settings.timeEstimatePresets')} />
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
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>{formatTimeEstimateLabel(value)}</Text>
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
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.resetToDefault')}</Text>
                        </View>
                    </TouchableOpacity>
                </ScrollView>
            </SafeAreaView>
        );
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
        { id: 'simple', label: localize('Simple', '简洁') },
        { id: 'standard', label: localize('Standard', '标准') },
        { id: 'full', label: localize('Full', '完整') },
    ];
    const activeTaskEditorPreset = resolveTaskEditorPresetId({
        order: taskEditorOrder,
        hidden: hiddenSet,
        sections: settings.gtd?.taskEditor?.sections,
        sectionOpen: settings.gtd?.taskEditor?.sectionOpen,
        featureHiddenFields,
    });
    const taskEditorHelperText = localize(
        'Choose a preset, then open a section to fine-tune fields.',
        '先选择一个预设，再展开分组微调字段。'
    );
    const taskEditorCustomLabel = localize('Current layout: Custom', '当前布局：自定义');
    const taskEditorPresetLabel = localize('Presets', '预设');
    const taskEditorMoveSectionLabel = localize('Move to section', '移动到分组');
    const taskEditorOrderLabel = localize('Order within section', '调整分组内顺序');
    const taskEditorKeepOpenLabel = localize(
        'Start task editing with this section expanded.',
        '编辑任务时默认展开此分组。'
    );
    const showInEditorLabel = localize('Show in editor', '在编辑器中显示');
    const moveUpLabel = localize('Move up', '上移');
    const moveDownLabel = localize('Move down', '下移');
    const doneLabel = t('common.done') === 'common.done' ? localize('Done', '完成') : t('common.done');

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
            case 'contexts':
                return t('taskEdit.contextsLabel');
            case 'description':
                return t('taskEdit.descriptionLabel');
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
        nextFeatures?: AppData['settings']['features']
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
            <TouchableOpacity
                style={[
                    styles.taskEditorCompactRow,
                    { borderTopColor: tc.border },
                    (showTopBorder || !isFirst) && styles.taskEditorCompactRowBorder,
                ]}
                onPress={() => setTaskEditorSelectedField(fieldId)}
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
                <View style={styles.settingInfo}>
                    <Text style={[styles.settingLabel, { color: tc.text }]}>{fieldLabel(fieldId)}</Text>
                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                        {visible ? t('settings.visible') : t('settings.hidden')}
                    </Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={tc.secondaryText} />
            </TouchableOpacity>
        );
    }

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
            <SettingsTopBar />
            <SubHeader title={t('settings.taskEditorLayout')} />
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
                                    <Text style={[styles.taskEditorPresetButtonText, { color: selected ? tc.tint : tc.secondaryText }]}>
                                        {option.label}
                                    </Text>
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
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>{group.title}</Text>
                                    <View style={[styles.taskEditorSectionCountBadge, { backgroundColor: tc.filterBg }]}>
                                        <Text style={[styles.taskEditorSectionCountText, { color: tc.tint }]}>{groupOrder.length}</Text>
                                    </View>
                                </View>
                                <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color={tc.secondaryText} />
                            </TouchableOpacity>
                            {expanded && (
                                <>
                                    {group.id !== 'basic' && (
                                        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                            <View style={styles.settingInfo}>
                                                <Text style={[styles.settingLabel, { color: tc.text }]}>{resolvedTaskEditorDefaultOpenLabel}</Text>
                                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{taskEditorKeepOpenLabel}</Text>
                                            </View>
                                            <Switch
                                                value={taskEditorSectionOpen[group.id]}
                                                onValueChange={(value) => updateSectionOpenDefault(group.id as Exclude<TaskEditorSectionId, 'basic'>, value)}
                                                trackColor={{ false: '#767577', true: '#3B82F6' }}
                                            />
                                        </View>
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
                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.resetToDefault')}</Text>
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

                                <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: tc.text }]}>{showInEditorLabel}</Text>
                                    </View>
                                    <Switch
                                        value={selectedFieldVisible}
                                        onValueChange={() => toggleFieldVisibility(selectedFieldId)}
                                        trackColor={{ false: '#767577', true: '#3B82F6' }}
                                    />
                                </View>

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
                                    style={[styles.taskEditorSheetDoneButton, { backgroundColor: tc.tint }]}
                                    onPress={() => setTaskEditorSelectedField(null)}
                                >
                                    <Text style={styles.taskEditorSheetDoneButtonText}>{doneLabel}</Text>
                                </TouchableOpacity>
                            </>
                        )}
                    </View>
                </View>
            </Modal>
        </SafeAreaView>
    );
}
