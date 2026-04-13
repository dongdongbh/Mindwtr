import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { CalendarDays, Folder, Flag, X, AtSign, Mic, Square } from 'lucide-react-native';
import DateTimePicker from '@react-native-community/datetimepicker';

import {
  DEFAULT_PROJECT_COLOR,
  getUsedTaskTokens,
  parseQuickAdd,
  safeFormatDate,
  safeParseDate,
  type Task,
  type TaskPriority,
  useTaskStore,
} from '@mindwtr/core';
import { useLanguage } from '../contexts/language-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';
import { useToast } from '@/contexts/toast-context';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { logError, logWarn } from '../lib/app-log';
import {
  buildCaptureExtra,
  normalizeContextToken,
  parseContextQueryTokens,
} from './quick-capture-sheet.utils';
import { useQuickCaptureAudio } from './use-quick-capture-audio';

const PRIORITY_OPTIONS: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];

const logCaptureWarn = (message: string, error?: unknown) => {
  void logWarn(message, { scope: 'capture', extra: buildCaptureExtra(undefined, error) });
};

const logCaptureError = (message: string, error?: unknown) => {
  const err = error instanceof Error ? error : new Error(message);
  void logError(err, { scope: 'capture', extra: buildCaptureExtra(message, error) });
};

export function QuickCaptureSheet({
  visible,
  onClose,
  initialProps,
  initialValue,
  autoRecord,
}: {
  visible: boolean;
  onClose: () => void;
  initialProps?: Partial<Task>;
  initialValue?: string;
  autoRecord?: boolean;
}) {
  const { addTask, addProject, updateSettings, projects, settings, tasks, areas } = useTaskStore();
  const { t } = useLanguage();
  const tc = useThemeColors();
  const { showToast } = useToast();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const inputRef = useRef<TextInput>(null);
  const contextInputRef = useRef<TextInput>(null);
  const prioritiesEnabled = settings?.features?.priorities !== false;
  const { selectedAreaIdForNewTasks } = useMobileAreaFilter();

  const updateSpeechSettings = useCallback(
    (next: Partial<NonNullable<NonNullable<typeof settings.ai>['speechToText']>>) => {
      updateSettings({
        ai: {
          ...(settings.ai ?? {}),
          speechToText: {
            ...(settings.ai?.speechToText ?? {}),
            ...next,
          },
        },
      }).catch((error) => logCaptureWarn('Failed to update speech settings', error));
    },
    [settings, updateSettings]
  );

  const [value, setValue] = useState('');
  const [dueDate, setDueDate] = useState<Date | null>(null);
  const [startTime, setStartTime] = useState<Date | null>(null);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [startPickerMode, setStartPickerMode] = useState<'date' | 'time' | null>(null);
  const [pendingStartDate, setPendingStartDate] = useState<Date | null>(null);
  const [contextTags, setContextTags] = useState<string[]>([]);
  const [showContextPicker, setShowContextPicker] = useState(false);
  const [contextQuery, setContextQuery] = useState('');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [projectQuery, setProjectQuery] = useState('');
  const [selectedAreaId, setSelectedAreaId] = useState<string | null>(null);
  const [showAreaPicker, setShowAreaPicker] = useState(false);
  const [priority, setPriority] = useState<TaskPriority | null>(null);
  const [showPriorityPicker, setShowPriorityPicker] = useState(false);
  const [addAnother, setAddAnother] = useState(false);

  const filteredProjects = useMemo(() => {
    const visibleProjects = projects.filter((project) => !project.deletedAt);
    const areaFilteredProjects = selectedAreaId
      ? visibleProjects.filter((project) => project.areaId === selectedAreaId)
      : visibleProjects;
    const query = projectQuery.trim().toLowerCase();
    if (!query) return areaFilteredProjects;
    return areaFilteredProjects.filter((project) => project.title.toLowerCase().includes(query));
  }, [projectQuery, projects, selectedAreaId]);

  const contextOptions = useMemo(() => {
    const initialContexts = initialProps?.contexts ?? [];
    return Array.from(
      new Set(
        [...getUsedTaskTokens(tasks, (task) => task.contexts, { prefix: '@' }), ...initialContexts]
          .map((item) => normalizeContextToken(String(item || '')))
          .filter(Boolean)
      )
    );
  }, [initialProps?.contexts, tasks]);

  const queryContextTokens = useMemo(() => parseContextQueryTokens(contextQuery), [contextQuery]);

  const filteredContexts = useMemo(() => {
    const query = queryContextTokens[0]?.toLowerCase() ?? '';
    if (!query) return contextOptions;
    return contextOptions.filter((token) => token.toLowerCase().includes(query));
  }, [contextOptions, queryContextTokens]);

  const hasAddableContextTokens = useMemo(() => {
    if (queryContextTokens.length === 0) return false;
    return queryContextTokens.some(
      (token) => !contextTags.some((selected) => selected.toLowerCase() === token.toLowerCase())
    );
  }, [contextTags, queryContextTokens]);

  const addContextFromQuery = useCallback(() => {
    const pendingTokens = parseContextQueryTokens(contextQuery);
    if (pendingTokens.length === 0) return 0;
    const resolvedTokens = pendingTokens.map((token) =>
      contextOptions.find((item) => item.toLowerCase() === token.toLowerCase()) ?? token
    );
    let addedCount = 0;
    setContextTags((prev) => {
      const next = [...prev];
      for (const token of resolvedTokens) {
        const exists = next.some((item) => item.toLowerCase() === token.toLowerCase());
        if (exists) continue;
        next.push(token);
        addedCount += 1;
      }
      return next;
    });
    setContextQuery('');
    return addedCount;
  }, [contextOptions, contextQuery]);

  const handleContextSubmit = useCallback(() => {
    addContextFromQuery();
    requestAnimationFrame(() => {
      contextInputRef.current?.focus();
    });
  }, [addContextFromQuery]);

  const submitProjectQuery = useCallback(async () => {
    const title = projectQuery.trim();
    if (!title) return;
    const match = projects.find((project) => project.title.toLowerCase() === title.toLowerCase());
    if (match) {
      setProjectId(match.id);
      setSelectedAreaId(null);
      setShowProjectPicker(false);
      setProjectQuery('');
      Keyboard.dismiss();
      return;
    }
    const created = await addProject(title, DEFAULT_PROJECT_COLOR);
    if (!created) return;
    setProjectId(created.id);
    setSelectedAreaId(null);
    setShowProjectPicker(false);
    setProjectQuery('');
    Keyboard.dismiss();
  }, [addProject, projectQuery, projects]);

  const hasExactProjectMatch = useMemo(() => {
    if (!projectQuery.trim()) return false;
    const query = projectQuery.trim().toLowerCase();
    return projects.some((project) => project.title.toLowerCase() === query);
  }, [projectQuery, projects]);

  useEffect(() => {
    if (!visible) return;
    setValue(initialValue ?? '');
    setDueDate(initialProps?.dueDate ? safeParseDate(initialProps.dueDate) : null);
    setStartTime(initialProps?.startTime ? safeParseDate(initialProps.startTime) : null);
    const initialContextTokens = Array.from(
      new Set(
        (initialProps?.contexts ?? [])
          .map((item) => normalizeContextToken(String(item || '')))
          .filter(Boolean)
      )
    );
    setContextTags(initialContextTokens);
    setProjectId(initialProps?.projectId ?? null);
    setSelectedAreaId(initialProps?.projectId ? null : (initialProps?.areaId ?? selectedAreaIdForNewTasks ?? null));
    setPriority((initialProps?.priority as TaskPriority) ?? null);
    if (autoRecord) return;
    const handle = setTimeout(() => inputRef.current?.focus(), 120);
    return () => clearTimeout(handle);
  }, [autoRecord, visible, initialProps, initialValue, selectedAreaIdForNewTasks]);

  useEffect(() => {
    if (prioritiesEnabled) return;
    setPriority(null);
    setShowPriorityPicker(false);
  }, [prioritiesEnabled]);

  const buildTaskProps = useCallback(async (fallbackTitle: string, extraProps?: Partial<Task>) => {
    const trimmed = value.trim();
    let finalTitle = trimmed || fallbackTitle;
    let projectTitle: string | undefined;
    let parsedProps: Partial<Task> = {};
    let invalidDateCommands: string[] | undefined;
    let detectedDate:
      | {
          date: string;
          matchedText: string;
          titleWithoutDate: string;
        }
      | undefined;

    if (trimmed) {
      const parsed = parseQuickAdd(trimmed, projects, new Date(), areas);
      finalTitle = parsed.title || trimmed;
      parsedProps = parsed.props;
      projectTitle = parsed.projectTitle;
      invalidDateCommands = parsed.invalidDateCommands;
      detectedDate = parsed.detectedDate;
    }

    const initialPropsMerged: Partial<Task> = { status: 'inbox', ...initialProps, ...parsedProps, ...extraProps };
    if (!initialPropsMerged.status) initialPropsMerged.status = 'inbox';
    const shouldApplyDetectedDate = Boolean(detectedDate?.date && !initialPropsMerged.dueDate && !dueDate);
    if (shouldApplyDetectedDate && detectedDate) {
      initialPropsMerged.dueDate = detectedDate.date;
      finalTitle = detectedDate.titleWithoutDate;
    }

    if (!initialPropsMerged.projectId && projectTitle) {
      const created = await addProject(projectTitle, DEFAULT_PROJECT_COLOR);
      if (!created) return { title: finalTitle, props: initialPropsMerged, invalidDateCommands };
      initialPropsMerged.projectId = created.id;
    }

    if (projectId) initialPropsMerged.projectId = projectId;
    if (!initialPropsMerged.projectId && selectedAreaId) initialPropsMerged.areaId = selectedAreaId;
    if (initialPropsMerged.projectId) initialPropsMerged.areaId = undefined;
    if (contextTags.length > 0) {
      initialPropsMerged.contexts = Array.from(new Set([...(initialPropsMerged.contexts ?? []), ...contextTags]));
    }
    if (prioritiesEnabled && priority) initialPropsMerged.priority = priority;
    if (dueDate) initialPropsMerged.dueDate = dueDate.toISOString();
    if (startTime) initialPropsMerged.startTime = startTime.toISOString();

    return { title: finalTitle, props: initialPropsMerged, invalidDateCommands };
  }, [addProject, areas, contextTags, dueDate, initialProps, prioritiesEnabled, priority, projectId, projects, selectedAreaId, startTime, value]);

  const resetState = useCallback(() => {
    setValue('');
    setDueDate(null);
    setStartTime(null);
    setContextTags([]);
    setContextQuery('');
    setShowContextPicker(false);
    setProjectId(null);
    setSelectedAreaId(selectedAreaIdForNewTasks ?? null);
    setPriority(null);
    setProjectQuery('');
    setShowProjectPicker(false);
    setShowAreaPicker(false);
    setShowPriorityPicker(false);
    setShowDatePicker(false);
    setStartPickerMode(null);
    setPendingStartDate(null);
  }, [selectedAreaIdForNewTasks]);

  const finalizeClose = useCallback(() => {
    resetState();
    onClose();
  }, [onClose, resetState]);

  const {
    recording,
    recordingBusy,
    recordingReady,
    startRecording,
    stopRecording,
  } = useQuickCaptureAudio({
    addTask,
    autoRecord,
    buildTaskProps,
    handleClose: finalizeClose,
    initialAttachments: initialProps?.attachments,
    onError: logCaptureError,
    onWarn: logCaptureWarn,
    settings,
    t,
    updateSpeechSettings,
    visible,
  });

  const handleClose = useCallback(() => {
    if (recording && !recordingBusy) {
      void stopRecording({ saveTask: false });
    }
    finalizeClose();
  }, [finalizeClose, recording, recordingBusy, stopRecording]);

  const handleSave = useCallback(async () => {
    if (!value.trim()) return;
    const { title, props, invalidDateCommands } = await buildTaskProps(value.trim());
    if (invalidDateCommands && invalidDateCommands.length > 0) {
      showToast({
        title: t('common.notice'),
        message: `${t('quickAdd.invalidDateCommand')}: ${invalidDateCommands.join(', ')}`,
        tone: 'warning',
        durationMs: 4200,
      });
      return;
    }
    if (!title.trim()) return;

    await addTask(title, props);

    if (addAnother) {
      setValue('');
      setTimeout(() => inputRef.current?.focus(), 80);
      return;
    }

    finalizeClose();
  }, [addAnother, addTask, buildTaskProps, finalizeClose, showToast, t, value]);

  const selectedProject = projectId ? projects.find((project) => project.id === projectId) : null;
  const dueLabel = dueDate ? safeFormatDate(dueDate, 'P') : t('taskEdit.dueDateLabel');
  const contextLabel = contextTags.length === 0
    ? t('taskEdit.contextsLabel')
    : `${contextTags[0].replace(/^@+/, '')}${contextTags.length > 1 ? ` +${contextTags.length - 1}` : ''}`;
  const projectLabel = selectedProject ? selectedProject.title : t('taskEdit.projectLabel');
  const areaLabel = selectedAreaId
    ? areas.find((area) => area.id === selectedAreaId)?.name || t('taskEdit.noAreaOption')
    : t('taskEdit.noAreaOption');
  const priorityLabel = priority ? t(`priority.${priority}`) : t('taskEdit.priorityLabel');
  const sheetMaxHeight = Math.max(260, windowHeight - Math.max(insets.top, 12) - 8);

  const openDueDatePicker = useCallback(() => {
    inputRef.current?.blur();
    Keyboard.dismiss();
    if (Platform.OS === 'ios') {
      setTimeout(() => setShowDatePicker(true), 120);
      return;
    }
    setShowDatePicker(true);
  }, []);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={handleClose}>
      <Pressable
        style={styles.backdrop}
        onPress={handleClose}
        accessibilityRole="button"
        accessibilityLabel={t('common.close')}
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
        style={styles.keyboardAvoiding}
      >
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: tc.cardBg,
              paddingBottom: Math.max(20, insets.bottom + 12),
              maxHeight: sheetMaxHeight,
            },
          ]}
        >
          <View style={styles.headerRow}>
            <Text style={[styles.title, { color: tc.text }]}>{t('nav.addTask')}</Text>
            <TouchableOpacity onPress={handleClose} accessibilityLabel={t('common.close')}>
              <X size={18} color={tc.secondaryText} />
            </TouchableOpacity>
          </View>

          <View style={styles.inputRow}>
            <TextInput
              ref={inputRef}
              style={[styles.input, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
              placeholder={t('quickAdd.placeholder')}
              placeholderTextColor={tc.secondaryText}
              value={value}
              onChangeText={setValue}
              onSubmitEditing={() => {
                if (Platform.OS === 'ios') {
                  inputRef.current?.blur();
                  Keyboard.dismiss();
                  return;
                }
                void handleSave();
              }}
              returnKeyType="done"
              blurOnSubmit
            />
            <TouchableOpacity
              onPress={() => {
                if (recording) {
                  void stopRecording({ saveTask: true });
                } else {
                  void startRecording();
                }
              }}
              accessibilityRole="button"
              accessibilityLabel={recording ? t('quickAdd.audioStop') : t('quickAdd.audioRecord')}
              style={[
                styles.recordButton,
                {
                  backgroundColor: recordingReady ? tc.danger : tc.filterBg,
                  borderColor: tc.border,
                  opacity: recordingBusy ? 0.6 : 1,
                },
              ]}
              disabled={recordingBusy}
            >
              {recordingReady ? (
                <Square size={16} color={tc.onTint} />
              ) : (
                <Mic size={16} color={tc.text} />
              )}
            </TouchableOpacity>
          </View>

          {recordingReady && (
            <View style={styles.recordingRow}>
              <View style={[styles.recordingDot, { backgroundColor: tc.danger }]} />
              <Text style={[styles.recordingText, { color: tc.danger }]}>{t('quickAdd.audioRecording')}</Text>
            </View>
          )}

          <View style={styles.optionsRow}>
            <TouchableOpacity
              style={[styles.optionChip, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
              onPress={openDueDatePicker}
              onLongPress={() => setDueDate(null)}
              accessibilityRole="button"
              accessibilityLabel={`${t('taskEdit.dueDate')}: ${dueLabel}`}
            >
              <CalendarDays size={16} color={tc.text} />
              <Text style={[styles.optionText, { color: tc.text }]} numberOfLines={1}>{dueLabel}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.optionChip, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
              onPress={() => setShowContextPicker(true)}
              onLongPress={() => setContextTags([])}
              accessibilityRole="button"
              accessibilityLabel={`${t('taskEdit.contextsLabel')}: ${contextLabel}`}
            >
              <AtSign size={16} color={tc.text} />
              <Text style={[styles.optionText, { color: tc.text }]} numberOfLines={1}>{contextLabel}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.optionChip, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
              onPress={() => setShowAreaPicker(true)}
              onLongPress={() => setSelectedAreaId(null)}
              accessibilityRole="button"
              accessibilityLabel={`${t('taskEdit.areaLabel')}: ${areaLabel}`}
            >
              <Text style={[styles.optionText, { color: tc.text }]} numberOfLines={1}>{areaLabel}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.optionChip, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
              onPress={() => setShowProjectPicker(true)}
              onLongPress={() => {
                setProjectId(null);
                setSelectedAreaId(selectedAreaIdForNewTasks ?? null);
              }}
              accessibilityRole="button"
              accessibilityLabel={`${t('taskEdit.project')}: ${projectLabel}`}
            >
              <Folder size={16} color={tc.text} />
              <Text style={[styles.optionText, { color: tc.text }]} numberOfLines={1}>{projectLabel}</Text>
            </TouchableOpacity>

            {prioritiesEnabled && (
              <TouchableOpacity
                style={[styles.optionChip, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
                onPress={() => setShowPriorityPicker(true)}
                onLongPress={() => setPriority(null)}
                accessibilityRole="button"
                accessibilityLabel={`${t('taskEdit.priorityLabel')}: ${priorityLabel}`}
              >
                <Flag size={16} color={tc.text} />
                <Text style={[styles.optionText, { color: tc.text }]} numberOfLines={1}>{priorityLabel}</Text>
              </TouchableOpacity>
            )}
          </View>

          <View style={styles.footerRow}>
            <View style={styles.toggleRow}>
              <Switch
                value={addAnother}
                onValueChange={setAddAnother}
                thumbColor={addAnother ? tc.tint : tc.border}
                trackColor={{ false: tc.border, true: `${tc.tint}55` }}
                accessibilityLabel={t('quickAdd.addAnother')}
              />
              <Text style={[styles.toggleText, { color: tc.text }]}>{t('quickAdd.addAnother')}</Text>
            </View>
            <TouchableOpacity
              onPress={() => {
                void handleSave();
              }}
              style={[styles.saveButton, { backgroundColor: tc.tint, opacity: value.trim() ? 1 : 0.5 }]}
              disabled={!value.trim()}
              accessibilityRole="button"
              accessibilityLabel={t('common.save')}
            >
              <Text style={styles.saveText}>{t('common.save')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>

      {showDatePicker && (
        <DateTimePicker
          value={dueDate ?? new Date()}
          mode="date"
          display={Platform.OS === 'ios' ? 'inline' : 'default'}
          onChange={(event, selectedDate) => {
            if (event.type === 'dismissed') {
              setShowDatePicker(false);
              return;
            }
            if (Platform.OS !== 'ios') {
              setShowDatePicker(false);
            }
            if (selectedDate) setDueDate(selectedDate);
          }}
        />
      )}

      {startPickerMode && (
        <DateTimePicker
          value={(() => {
            if (Platform.OS === 'ios') return startTime ?? new Date();
            if (startPickerMode === 'time') return pendingStartDate ?? startTime ?? new Date();
            return startTime ?? new Date();
          })()}
          mode={Platform.OS === 'ios' ? 'datetime' : startPickerMode}
          display={Platform.OS === 'ios' ? 'inline' : 'default'}
          onChange={(event, selectedDate) => {
            if (event.type === 'dismissed') {
              setStartPickerMode(null);
              setPendingStartDate(null);
              return;
            }
            if (!selectedDate) return;
            if (Platform.OS === 'ios') {
              setStartTime(selectedDate);
              return;
            }
            if (startPickerMode === 'date') {
              const base = new Date(selectedDate);
              const existing = startTime ?? pendingStartDate;
              if (existing) {
                base.setHours(existing.getHours(), existing.getMinutes(), 0, 0);
              }
              setPendingStartDate(base);
              setStartPickerMode('time');
              return;
            }
            const base = pendingStartDate ?? startTime ?? new Date();
            const combined = new Date(base);
            combined.setHours(selectedDate.getHours(), selectedDate.getMinutes(), 0, 0);
            setStartTime(combined);
            setPendingStartDate(null);
            setStartPickerMode(null);
          }}
        />
      )}

      <Modal
        visible={showContextPicker}
        transparent
        animationType="fade"
        onRequestClose={() => setShowContextPicker(false)}
      >
        <View style={styles.overlay}>
          <Pressable
            style={styles.overlayBackdrop}
            onPress={() => setShowContextPicker(false)}
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
          />
          <View style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
            <Text style={[styles.pickerTitle, { color: tc.text }]}>{t('taskEdit.contextsLabel')}</Text>
            <TextInput
              ref={contextInputRef}
              value={contextQuery}
              onChangeText={setContextQuery}
              placeholder={t('taskEdit.contextsPlaceholder')}
              placeholderTextColor={tc.secondaryText}
              style={[styles.pickerInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
              onSubmitEditing={handleContextSubmit}
              returnKeyType="done"
              blurOnSubmit={false}
              submitBehavior="submit"
            />
            {hasAddableContextTokens && contextQuery.trim() && (
              <Pressable
                onPress={addContextFromQuery}
                style={styles.pickerRow}
                accessibilityRole="button"
                accessibilityLabel={`${t('common.add')}: ${parseContextQueryTokens(contextQuery).join(', ')}`}
              >
                <Text style={[styles.pickerRowText, { color: tc.tint }]}>
                  + {parseContextQueryTokens(contextQuery).join(', ')}
                </Text>
              </Pressable>
            )}
            {contextTags.length > 0 && (
              <View style={styles.selectedContextWrap}>
                {contextTags.map((token) => (
                  <Pressable
                    key={token}
                    onPress={() => {
                      setContextTags((prev) => prev.filter((item) => item.toLowerCase() !== token.toLowerCase()));
                    }}
                    style={[styles.selectedContextChip, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
                    accessibilityRole="button"
                    accessibilityLabel={`${t('common.delete')}: ${token}`}
                  >
                    <Text style={[styles.selectedContextChipText, { color: tc.text }]}>{token}</Text>
                  </Pressable>
                ))}
              </View>
            )}
            <FlatList
              style={[styles.pickerList, { borderColor: tc.border }]}
              contentContainerStyle={styles.pickerListContent}
              data={filteredContexts}
              keyExtractor={(token) => token}
              keyboardShouldPersistTaps="handled"
              ListHeaderComponent={(
                <Pressable
                  onPress={() => {
                    setContextTags([]);
                    setShowContextPicker(false);
                  }}
                  style={styles.pickerRow}
                  accessibilityRole="button"
                  accessibilityLabel={t('common.clear')}
                >
                  <Text style={[styles.pickerRowText, { color: tc.text }]}>{t('common.clear')}</Text>
                </Pressable>
              )}
              renderItem={({ item: token }) => (
                <Pressable
                  onPress={() => {
                    setContextTags((prev) => {
                      const exists = prev.some((item) => item.toLowerCase() === token.toLowerCase());
                      if (exists) {
                        return prev.filter((item) => item.toLowerCase() !== token.toLowerCase());
                      }
                      return [...prev, token];
                    });
                    setContextQuery('');
                  }}
                  style={[
                    styles.pickerRow,
                    contextTags.some((item) => item.toLowerCase() === token.toLowerCase())
                      ? { backgroundColor: tc.filterBg, borderRadius: 8 }
                      : null,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={
                    contextTags.some((item) => item.toLowerCase() === token.toLowerCase())
                      ? `${t('common.delete')}: ${token}`
                      : `${t('common.add')}: ${token}`
                  }
                >
                  <Text style={[styles.pickerRowText, { color: tc.text }]}>
                    {contextTags.some((item) => item.toLowerCase() === token.toLowerCase()) ? `✓ ${token}` : token}
                  </Text>
                </Pressable>
              )}
            />
          </View>
        </View>
      </Modal>

      <Modal
        visible={showAreaPicker}
        transparent
        animationType="fade"
        onRequestClose={() => setShowAreaPicker(false)}
      >
        <View style={styles.overlay}>
          <Pressable
            style={styles.overlayBackdrop}
            onPress={() => setShowAreaPicker(false)}
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
          />
          <View style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
            <Text style={[styles.pickerTitle, { color: tc.text }]}>{t('taskEdit.areaLabel')}</Text>
            <FlatList
              style={[styles.pickerList, { borderColor: tc.border }]}
              contentContainerStyle={styles.pickerListContent}
              data={areas.filter((area) => !area.deletedAt)}
              keyExtractor={(area) => area.id}
              keyboardShouldPersistTaps="handled"
              ListHeaderComponent={(
                <Pressable
                  onPress={() => {
                    setSelectedAreaId(null);
                    setShowAreaPicker(false);
                  }}
                  style={styles.pickerRow}
                  accessibilityRole="button"
                  accessibilityLabel={t('taskEdit.noAreaOption')}
                >
                  <Text style={[styles.pickerRowText, { color: tc.text }]}>{t('taskEdit.noAreaOption')}</Text>
                </Pressable>
              )}
              renderItem={({ item: area }) => (
                <Pressable
                  onPress={() => {
                    setSelectedAreaId(area.id);
                    setProjectId(null);
                    setShowAreaPicker(false);
                  }}
                  style={styles.pickerRow}
                  accessibilityRole="button"
                  accessibilityLabel={area.name}
                >
                  <Text style={[styles.pickerRowText, { color: tc.text }]}>{area.name}</Text>
                </Pressable>
              )}
            />
          </View>
        </View>
      </Modal>

      <Modal
        visible={showProjectPicker}
        transparent
        animationType="fade"
        onRequestClose={() => setShowProjectPicker(false)}
      >
        <View style={styles.overlay}>
          <Pressable
            style={styles.overlayBackdrop}
            onPress={() => setShowProjectPicker(false)}
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
          />
          <View style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
            <Text style={[styles.pickerTitle, { color: tc.text }]}>{t('taskEdit.projectLabel')}</Text>
            <TextInput
              value={projectQuery}
              onChangeText={setProjectQuery}
              placeholder={t('projects.addPlaceholder')}
              placeholderTextColor={tc.secondaryText}
              style={[styles.pickerInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
              onSubmitEditing={() => {
                void submitProjectQuery();
              }}
              returnKeyType="done"
              blurOnSubmit
            />
            {!hasExactProjectMatch && projectQuery.trim() && (
              <Pressable
                onPress={() => {
                  void submitProjectQuery();
                }}
                style={styles.pickerRow}
                accessibilityRole="button"
                accessibilityLabel={`${t('projects.create')}: ${projectQuery.trim()}`}
              >
                <Text style={[styles.pickerRowText, { color: tc.tint }]}>+ {t('projects.create')} &quot;{projectQuery.trim()}&quot;</Text>
              </Pressable>
            )}
            <FlatList
              style={[styles.pickerList, { borderColor: tc.border }]}
              contentContainerStyle={styles.pickerListContent}
              data={filteredProjects}
              keyExtractor={(project) => project.id}
              keyboardShouldPersistTaps="handled"
              ListHeaderComponent={(
                <Pressable
                  onPress={() => {
                    setProjectId(null);
                    setShowProjectPicker(false);
                  }}
                  style={styles.pickerRow}
                  accessibilityRole="button"
                  accessibilityLabel={t('taskEdit.noProjectOption')}
                >
                  <Text style={[styles.pickerRowText, { color: tc.text }]}>{t('taskEdit.noProjectOption')}</Text>
                </Pressable>
              )}
              renderItem={({ item: project }) => (
                <Pressable
                  onPress={() => {
                    setProjectId(project.id);
                    setSelectedAreaId(null);
                    setShowProjectPicker(false);
                  }}
                  style={styles.pickerRow}
                  accessibilityRole="button"
                  accessibilityLabel={project.title}
                >
                  <Text style={[styles.pickerRowText, { color: tc.text }]}>{project.title}</Text>
                </Pressable>
              )}
            />
          </View>
        </View>
      </Modal>

      {prioritiesEnabled && (
        <Modal
          visible={showPriorityPicker}
          transparent
          animationType="fade"
          onRequestClose={() => setShowPriorityPicker(false)}
        >
          <View style={styles.overlay}>
            <Pressable
              style={styles.overlayBackdrop}
              onPress={() => setShowPriorityPicker(false)}
              accessibilityRole="button"
              accessibilityLabel={t('common.close')}
            />
            <View style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
              <Text style={[styles.pickerTitle, { color: tc.text }]}>{t('taskEdit.priorityLabel')}</Text>
              <Pressable
                onPress={() => {
                  setPriority(null);
                  setShowPriorityPicker(false);
                }}
                style={styles.pickerRow}
                accessibilityRole="button"
                accessibilityLabel={t('common.clear')}
              >
                <Text style={[styles.pickerRowText, { color: tc.text }]}>{t('common.clear')}</Text>
              </Pressable>
              {PRIORITY_OPTIONS.map((option) => (
                <Pressable
                  key={option}
                  onPress={() => {
                    setPriority(option);
                    setShowPriorityPicker(false);
                  }}
                  style={styles.pickerRow}
                  accessibilityRole="button"
                  accessibilityLabel={t(`priority.${option}`)}
                >
                  <Text style={[styles.pickerRowText, { color: tc.text }]}>{t(`priority.${option}`)}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        </Modal>
      )}
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  keyboardAvoiding: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  recordButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordingRow: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  recordingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  recordingText: {
    fontSize: 12,
    fontWeight: '600',
  },
  optionsRow: {
    marginTop: 12,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  optionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  optionText: {
    fontSize: 12,
    fontWeight: '600',
    maxWidth: 120,
  },
  footerRow: {
    marginTop: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  toggleText: {
    fontSize: 12,
    fontWeight: '600',
  },
  saveButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 999,
  },
  saveText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 13,
  },
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  overlayBackdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  pickerCard: {
    width: '100%',
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
  },
  pickerTitle: {
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 8,
  },
  pickerInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
  },
  pickerList: {
    marginTop: 10,
    borderWidth: 1,
    borderRadius: 10,
    maxHeight: 220,
  },
  pickerListContent: {
    paddingVertical: 6,
  },
  pickerRow: {
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  pickerRowText: {
    fontSize: 14,
    fontWeight: '600',
  },
  selectedContextWrap: {
    marginTop: 8,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  selectedContextChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  selectedContextChipText: {
    fontSize: 12,
    fontWeight: '600',
  },
});
