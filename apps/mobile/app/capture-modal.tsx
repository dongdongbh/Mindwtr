import React, { useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import {
  executeCaptureTransaction,
  prepareCaptureTask,
  buildQuickAddParseOptions,
  buildQuickAddPreviewEntries,
  createAIProvider,
  getUsedTaskTokens,
  isSelectableProjectForTaskAssignment,
  parseQuickAdd,
  resolveDefaultNewTaskAreaId,
  formatQuickAddHelp,
  resolveFeatureFlags,
  shallow,
  splitQuickAddBulkLines,
  tFallback,
  type AIProviderId,
  type Attachment,
  type CaptureAssemblyInput,
  type CaptureTransactionOptions,
  type Project,
  type Task,
  type TimeEstimate,
  useTaskStore,
} from '@mindwtr/core';
import { getAttachmentsDir } from '@/lib/attachment-sync-utils';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useToast } from '@/contexts/toast-context';
import { useLanguage } from '../contexts/language-context';
import { buildCopilotConfig, isAIKeyRequired, loadAIKey } from '../lib/ai-config';
import { logError } from '../lib/app-log';
import { addHardwareBackPressListener } from '@/lib/hardware-back';
import { showInvalidDateCommandToast } from '@/lib/quick-add-toast';
import { ThemedAlertHost } from '@/components/themed-alert';
import { QuickAddPreview } from '@/components/QuickAddPreview';
import type { CopilotPart } from '@/components/task-edit/use-task-edit-copilot';
import { openTaskScreen, stashPendingCaptureTaskOpen } from '@/lib/task-meta-navigation';
import { getProjectQuickCaptureReturnToProjectId } from '@/components/projects-screen/projects-screen.utils';

type CaptureSearchParams = {
  initialProps?: string;
  initialValue?: string;
  project?: string;
  returnTo?: string;
  text?: string;
  title?: string;
};

const URL_INITIAL_TASK_STATUSES = new Set<Task['status']>(['inbox', 'next', 'waiting', 'someday', 'reference']);
const BULK_PREVIEW_LINE_LIMIT = 5;

const firstSearchParam = (value: string | string[] | undefined): string => {
  if (Array.isArray(value)) return value[0] ?? '';
  return typeof value === 'string' ? value : '';
};

const decodeSearchParam = (value: string | string[] | undefined): string => {
  const raw = firstSearchParam(value);
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

export const sanitizeCaptureReturnToParam = (value: string | string[] | undefined): string | null => {
  const decoded = decodeSearchParam(value).trim();
  if (!decoded || !decoded.startsWith('/') || decoded.startsWith('//')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(decoded)) return null;
  if (/[\u0000-\u001F\u007F]/.test(decoded)) return null;
  return decoded;
};

const parseInitialPropsJson = (value: string | string[] | undefined): Record<string, unknown> => {
  const decoded = decodeSearchParam(value);
  if (!decoded) return {};
  try {
    const parsed = JSON.parse(decoded);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
};

const normalizeInitialTokenList = (value: unknown, prefix?: '@' | '#'): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const next: string[] = [];
  value.forEach((item) => {
    if (typeof item !== 'string') return;
    const trimmed = item.trim();
    if (!trimmed) return;
    const normalized = prefix && !trimmed.startsWith(prefix) ? `${prefix}${trimmed}` : trimmed;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    next.push(normalized);
  });
  return next.length > 0 ? next : undefined;
};

const MAX_INITIAL_ATTACHMENTS = 6;

// Share-intent file captures arrive as attachment records in the route's
// initialProps (the share handler already copied the bytes into the managed
// attachments dir). Route params are attacker-reachable via deep links, so
// only structurally valid file records survive here; capture request assembly
// additionally drops any uri outside the managed attachments dir.
const sanitizeInitialAttachments = (value: unknown): Attachment[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const next: Attachment[] = [];
  for (const item of value) {
    if (next.length >= MAX_INITIAL_ATTACHMENTS) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (record.kind !== 'file') continue;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const uri = typeof record.uri === 'string' ? record.uri.trim() : '';
    if (!id || !uri) continue;
    const now = new Date().toISOString();
    const createdAt = typeof record.createdAt === 'string' && record.createdAt ? record.createdAt : now;
    const attachment: Attachment = {
      id,
      kind: 'file',
      title: typeof record.title === 'string' && record.title.trim() ? record.title.trim() : 'Attachment',
      uri,
      createdAt,
      updatedAt: typeof record.updatedAt === 'string' && record.updatedAt ? record.updatedAt : createdAt,
      localStatus: 'available',
    };
    if (typeof record.mimeType === 'string' && record.mimeType.trim()) {
      attachment.mimeType = record.mimeType.trim();
    }
    if (typeof record.size === 'number' && Number.isFinite(record.size)) {
      attachment.size = record.size;
    }
    next.push(attachment);
  }
  return next.length > 0 ? next : undefined;
};

const filterManagedAttachments = async (attachments: Attachment[]): Promise<Attachment[]> => {
  const dir = await getAttachmentsDir();
  if (!dir) return [];
  return attachments.filter((attachment) => attachment.uri.startsWith(dir));
};

const sanitizeInitialPropsParam = (
  value: string | string[] | undefined,
  projects: Project[],
  areas: Array<{ id: string; deletedAt?: string | null }>,
): Partial<Task> => {
  const parsed = parseInitialPropsJson(value);
  const next: Partial<Task> = {};

  const attachments = sanitizeInitialAttachments(parsed.attachments);
  if (attachments) next.attachments = attachments;

  if (typeof parsed.description === 'string' && parsed.description.trim()) {
    next.description = parsed.description;
  }

  const tags = normalizeInitialTokenList(parsed.tags, '#');
  if (tags) next.tags = tags;

  const contexts = normalizeInitialTokenList(parsed.contexts, '@');
  if (contexts) next.contexts = contexts;

  const status = typeof parsed.status === 'string' ? parsed.status.trim().toLowerCase() : '';
  if (URL_INITIAL_TASK_STATUSES.has(status as Task['status'])) {
    next.status = status as Task['status'];
  }

  const projectId = typeof parsed.projectId === 'string' ? parsed.projectId.trim() : '';
  if (projectId && projects.some((project) => project.id === projectId && isSelectableProjectForTaskAssignment(project))) {
    next.projectId = projectId;
  }

  const areaId = typeof parsed.areaId === 'string' ? parsed.areaId.trim() : '';
  if (!next.projectId && areaId && areas.some((area) => area.id === areaId && !area.deletedAt)) {
    next.areaId = areaId;
  }

  return next;
};

export default function CaptureScreen() {
  const params = useLocalSearchParams<CaptureSearchParams>();
  const router = useRouter();
  const { addProject, addTask, addTasks, projects, tasks, settings, areas, people } = useTaskStore((state) => ({
    addProject: state.addProject,
    addTask: state.addTask,
    addTasks: state.addTasks,
    projects: state.projects,
    tasks: state.tasks,
    settings: state.settings,
    areas: state.areas,
    people: state.people,
  }), shallow);
  const tc = useThemeColors();
  const { showToast } = useToast();
  const { t } = useLanguage();
  const initialText = (
    decodeSearchParam(params.initialValue)
    || decodeSearchParam(params.text)
    || decodeSearchParam(params.title)
  );
  const initialProps = React.useMemo(
    () => sanitizeInitialPropsParam(params.initialProps, projects, areas),
    [areas, params.initialProps, projects]
  );
  const defaultNewTaskAreaId = resolveDefaultNewTaskAreaId(settings, areas);
  const returnTo = React.useMemo(
    () => sanitizeCaptureReturnToParam(params.returnTo),
    [params.returnTo]
  );
  const initialDescription = String(initialProps.description ?? '');
  const initialProjectTitle = decodeSearchParam(params.project).trim();
  const [value, setValue] = useState(initialText);
  const [pendingBulkLines, setPendingBulkLines] = useState<string[] | null>(null);
  const [descriptionValue, setDescriptionValue] = useState(initialDescription);
  const [copilotSuggestion, setCopilotSuggestion] = useState<{ context?: string; timeEstimate?: TimeEstimate; tags?: string[] } | null>(null);
  const [aiKey, setAiKey] = useState('');
  const [copilotContext, setCopilotContext] = useState<string | undefined>(undefined);
  const [copilotEstimate, setCopilotEstimate] = useState<TimeEstimate | undefined>(undefined);
  const [copilotTags, setCopilotTags] = useState<string[]>([]);
  const [showHelp, setShowHelp] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const copilotMountedRef = useRef(true);
  const copilotAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 120);
  }, []);

  useEffect(() => {
    setValue(initialText);
    setDescriptionValue(initialDescription);
  }, [initialDescription, initialText]);

  useEffect(() => {
    const showListener = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true));
    const hideListener = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
    return () => {
      showListener.remove();
      hideListener.remove();
    };
  }, []);

  const aiEnabled = settings.ai?.enabled === true;
  const aiProvider = (settings.ai?.provider ?? 'openai') as AIProviderId;
  const keyRequired = isAIKeyRequired(settings);
  const { priorities: prioritiesEnabled, timeEstimates: timeEstimatesEnabled } = resolveFeatureFlags(settings);

  useEffect(() => {
    loadAIKey(aiProvider).then(setAiKey).catch((error) => {
      void logError(error, { scope: 'ai', extra: { message: 'Failed to load AI key' } });
      showToast({
        title: t('ai.errorTitle'),
        message: t('ai.disabledBody'),
        tone: 'warning',
        durationMs: 4200,
      });
    });
  }, [aiProvider, showToast, t]);

  const contextOptions = React.useMemo(() => {
    return getUsedTaskTokens(tasks, (task) => task.contexts, { prefix: '@' });
  }, [tasks]);
  const tagOptions = React.useMemo(() => {
    return getUsedTaskTokens(tasks, (task) => task.tags, { prefix: '#' });
  }, [tasks]);
  const quickAddParseOptions = React.useMemo(
    () => buildQuickAddParseOptions(settings, { tasks, people }),
    [people, settings, tasks]
  );

  // The parse the save path runs, one keystroke early. Same options object, so
  // the strip and the saved task can never disagree.
  const previewEntries = React.useMemo(() => {
    if (!value.trim()) return [];
    return buildQuickAddPreviewEntries(
      parseQuickAdd(value, projects, new Date(), areas, quickAddParseOptions),
      { t, projects, areas, rawInput: value },
    );
  }, [areas, projects, quickAddParseOptions, t, value]);

  useEffect(() => {
    if (!aiEnabled || (keyRequired && !aiKey)) {
      setCopilotSuggestion(null);
      return;
    }
    const title = value.trim();
    if (title.length < 4) {
      setCopilotSuggestion(null);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        if (copilotAbortRef.current) copilotAbortRef.current.abort();
        const abortController = typeof AbortController === 'function' ? new AbortController() : null;
        copilotAbortRef.current = abortController;
        const provider = createAIProvider(buildCopilotConfig(settings, aiKey));
        const suggestion = await provider.predictMetadata(
          { title, contexts: contextOptions, tags: tagOptions },
          abortController ? { signal: abortController.signal } : undefined
        );
        if (cancelled || !copilotMountedRef.current) return;
        if (!suggestion.context && (!timeEstimatesEnabled || !suggestion.timeEstimate) && !suggestion.tags?.length) {
          setCopilotSuggestion(null);
        } else {
          setCopilotSuggestion(suggestion);
        }
      } catch {
        if (!cancelled) {
          setCopilotSuggestion(null);
        }
      } finally {
        if (cancelled) return;
      }
    }, 800);
    return () => {
      cancelled = true;
      clearTimeout(handle);
      if (copilotAbortRef.current) {
        copilotAbortRef.current.abort();
        copilotAbortRef.current = null;
      }
    };
  }, [
    aiEnabled,
    aiKey,
    aiProvider,
    contextOptions,
    keyRequired,
    settings,
    settings.ai?.copilotModel,
    settings.ai?.thinkingBudget,
    tagOptions,
    timeEstimatesEnabled,
    value,
  ]);

  useEffect(() => {
    copilotMountedRef.current = true;
    return () => {
      copilotMountedRef.current = false;
      if (copilotAbortRef.current) {
        copilotAbortRef.current.abort();
        copilotAbortRef.current = null;
      }
    };
  }, []);

  const handleInputChange = (text: string) => {
    setValue(text);
    setCopilotContext(undefined);
    setCopilotEstimate(undefined);
    setCopilotTags([]);
  };

  // Same per-part apply as the task editor (#1022); here the parts are stashed
  // for task creation instead of written into a draft.
  const pendingCopilotParts = React.useMemo<CopilotPart[]>(() => {
    if (!copilotSuggestion) return [];
    const parts: CopilotPart[] = [];
    if (copilotSuggestion.context && copilotSuggestion.context !== copilotContext) {
      parts.push({ kind: 'context', value: copilotSuggestion.context });
    }
    if (timeEstimatesEnabled && copilotSuggestion.timeEstimate && copilotSuggestion.timeEstimate !== copilotEstimate) {
      parts.push({ kind: 'timeEstimate', value: copilotSuggestion.timeEstimate });
    }
    for (const tag of copilotSuggestion.tags ?? []) {
      if (!copilotTags.includes(tag)) parts.push({ kind: 'tag', value: tag });
    }
    return parts;
  }, [copilotContext, copilotEstimate, copilotSuggestion, copilotTags, timeEstimatesEnabled]);

  const hasAppliedCopilot = Boolean(copilotContext) || Boolean(copilotEstimate) || copilotTags.length > 0;

  const applyCopilotParts = (parts: CopilotPart[]) => {
    const context = parts.find((part) => part.kind === 'context')?.value;
    const estimate = parts.find((part) => part.kind === 'timeEstimate')?.value;
    const tags = parts.filter((part) => part.kind === 'tag').map((part) => part.value);
    if (context) setCopilotContext(context);
    if (estimate && timeEstimatesEnabled) setCopilotEstimate(estimate as TimeEstimate);
    if (tags.length) setCopilotTags((prev) => Array.from(new Set([...prev, ...tags])));
  };

  const placeholderColor = tc.secondaryText;

  const closeCapture = React.useCallback(() => {
    // A real back entry always wins: the screen underneath is the one that
    // opened capture, still holding the open project. Replacing capture with
    // returnTo instead left a duplicate screen on the stack after every save,
    // so leaving a project took one back tap per task added (#938). returnTo
    // stays as the fallback for a capture with nothing behind it (a restored
    // session that reopened straight into the capture route).
    if (router.canGoBack()) {
      router.back();
      return;
    }
    if (returnTo) {
      router.replace(returnTo as never);
      return;
    }
    router.replace('/inbox');
  }, [returnTo, router]);

  const handleCancel = () => {
    closeCapture();
  };

  const formatBulkConfirmTitle = (count: number) => (
    tFallback(t, 'quickAdd.bulkConfirmTitle', 'Create {{count}} tasks?')
      .replace('{{count}}', String(count))
  );

  const formatBulkConfirmMessage = (lines: string[]) => {
    const preview = lines.slice(0, BULK_PREVIEW_LINE_LIMIT).join('\n');
    const remaining = Math.max(0, lines.length - BULK_PREVIEW_LINE_LIMIT);
    const suffix = remaining > 0
      ? `\n${tFallback(t, 'quickAdd.bulkMoreLines', '+{{count}} more').replace('{{count}}', String(remaining))}`
      : '';
    return `${preview}${suffix}`;
  };

  const buildCaptureRequestFromInput = async (
    inputValue: string,
    currentProjects = projects,
  ): Promise<{ input: CaptureAssemblyInput; options: CaptureTransactionOptions } | null> => {
    if (!inputValue.trim()) return null;
    // Invalid date commands are not checked here: prepareCaptureTask rejects
    // them with a typed reason, so the warning is raised once, where the write
    // actually fails.
    const parsed = parseQuickAdd(inputValue, currentProjects, new Date(), areas, quickAddParseOptions);

    // The deep-link `project` param is contextual (an id or a title). It is a
    // best-effort fallback, not a typed +Project token: resolve a selectable
    // match up front, and simply skip it when it names an archived project.
    const surfaceProps: Partial<Task> = { ...initialProps };
    if (surfaceProps.attachments?.length) {
      const managed = await filterManagedAttachments(surfaceProps.attachments);
      if (managed.length > 0) {
        surfaceProps.attachments = managed;
      } else {
        delete surfaceProps.attachments;
      }
    }
    let fallbackProjectTitleToCreate: string | undefined;
    if (!parsed.props.projectId && !parsed.projectTitle && initialProjectTitle) {
      const ref = initialProjectTitle.toLowerCase();
      const match = currentProjects.find((project) => (
        project.id === initialProjectTitle || project.title.toLowerCase() === ref
      ));
      if (!match) {
        fallbackProjectTitleToCreate = initialProjectTitle;
      } else if (isSelectableProjectForTaskAssignment(match)) {
        surfaceProps.projectId = match.id;
      }
    }

    const input: CaptureAssemblyInput = {
      parsed: fallbackProjectTitleToCreate
        ? { ...parsed, projectTitle: fallbackProjectTitleToCreate }
        : parsed,
      rawInput: inputValue,
      projects: currentProjects,
      initialProps: surfaceProps,
      selectedAreaId: defaultNewTaskAreaId,
      starNewTask: false,
    };
    const options: CaptureTransactionOptions = {
      transformProps: (props) => {
        const taskProps = { ...props };
        const description = descriptionValue.trim();
        const parsedDescription = typeof taskProps.description === 'string' ? taskProps.description.trim() : '';
        if (description) {
          taskProps.description = parsedDescription && parsedDescription !== description
            ? `${description}\n${parsedDescription}`
            : description;
        }
        if (copilotContext) {
          taskProps.contexts = Array.from(new Set([...(taskProps.contexts ?? []), copilotContext]));
        }
        if (timeEstimatesEnabled && copilotEstimate && !taskProps.timeEstimate) {
          taskProps.timeEstimate = copilotEstimate;
        }
        if (copilotTags.length) {
          taskProps.tags = Array.from(new Set([...(taskProps.tags ?? []), ...copilotTags]));
        }
        return taskProps;
      },
    };
    return { input, options };
  };

  const createTaskFromInput = async (
    inputValue: string,
    { openAfterSave = false }: { openAfterSave?: boolean } = {},
  ): Promise<boolean> => {
    const request = await buildCaptureRequestFromInput(inputValue);
    if (!request) return false;
    const result = await executeCaptureTransaction(
      request.input,
      { addProject, addTask },
      request.options,
    );
    if (!result.success) {
      if (result.reason === 'invalid-date-command') {
        showInvalidDateCommandToast(showToast, t, result.invalidDateCommands);
      }
      return false;
    }
    const createdTaskId = result.createdTaskId;
    if (openAfterSave && createdTaskId) {
      // Leave this route, don't push over it: the capture screen must not
      // stay on the stack holding the saved text, or backing out of the
      // editor reopens it pre-filled (#1029).
      const returnToProjectId = getProjectQuickCaptureReturnToProjectId(returnTo);
      if (returnToProjectId && result.props.projectId === returnToProjectId) {
        // Opened from this project's own + button, so the project screen is
        // what capture closes back to. Navigating to it would stack a
        // duplicate of it (#938 trap — an extra back tap through an
        // identical page); stash the editor request for the screen's focus
        // effect and close exactly like a plain save.
        stashPendingCaptureTaskOpen({ taskId: createdTaskId, projectId: returnToProjectId, taskTab: 'task' });
        closeCapture();
      } else {
        openTaskScreen(createdTaskId, result.props.projectId, 'task', { replace: true });
      }
      return false;
    }
    return true;
  };

  const createBulkTasks = async (lines: string[]) => {
    const taskInputs: Array<{ title: string; initialProps: Partial<Task> }> = [];
    let currentProjects = projects;
    for (const line of lines) {
      const request = await buildCaptureRequestFromInput(line, currentProjects);
      if (!request) return;
      const prepared = await prepareCaptureTask(request.input, { addProject }, request.options);
      if (!prepared.success) {
        if (prepared.reason === 'invalid-date-command') {
          showInvalidDateCommandToast(showToast, t, prepared.invalidDateCommands);
        }
        return;
      }
      taskInputs.push({ title: prepared.title, initialProps: prepared.props });
      if (prepared.createdProject) currentProjects = [...currentProjects, prepared.createdProject];
    }
    // Shared files belong to one task, not one copy per line: the attachment
    // records share ids, so duplicating them across tasks would alias files.
    taskInputs.forEach((taskInput, index) => {
      if (index > 0) delete taskInput.initialProps.attachments;
    });
    const result = await addTasks(taskInputs);
    if (result && typeof result === 'object' && result.success === false) return;
    closeCapture();
  };

  // Confirm on this screen rather than through Alert. This route is presented
  // modally, and an alert raised over it is a second native presentation on top
  // of the first — on iOS it never became visible, so saving a multi-line paste
  // did nothing and left the screen blocked by an invisible dialog (#941).
  const handleSave = async ({ openAfterSave = false }: { openAfterSave?: boolean } = {}) => {
    if (!value.trim()) return;
    const bulkLines = splitQuickAddBulkLines(value);
    if (bulkLines.length > 1) {
      setPendingBulkLines(bulkLines);
      return;
    }
    const shouldClose = await createTaskFromInput(value, { openAfterSave });
    if (shouldClose) closeCapture();
  };

  useEffect(() => {
    if (!pendingBulkLines) return;
    const subscription = addHardwareBackPressListener(() => {
      setPendingBulkLines(null);
      return true;
    });
    return () => subscription.remove();
  }, [pendingBulkLines]);

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: tc.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        keyboardShouldPersistTaps="handled"
        accessibilityElementsHidden={Boolean(pendingBulkLines)}
        importantForAccessibility={pendingBulkLines ? 'no-hide-descendants' : 'auto'}
      >
        <View style={[styles.card, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
          <View style={styles.titleRow}>
            <Text style={[styles.title, { color: tc.text }]}>{t('nav.addTask')}</Text>
            <View style={styles.headerActions}>
              {keyboardVisible && (
                <TouchableOpacity
                  onPress={Keyboard.dismiss}
                  style={[styles.dismissKeyboardButton, { borderColor: tc.border, backgroundColor: tc.inputBg }]}
                  accessibilityRole="button"
                  accessibilityLabel={tFallback(t, 'common.hideKeyboard', 'Hide keyboard')}
                >
                  <Ionicons name="chevron-down" size={16} color={tc.text} />
                </TouchableOpacity>
              )}
              <TouchableOpacity
                onPress={() => setShowHelp((prev) => !prev)}
                style={[styles.helpToggle, { borderColor: tc.border, backgroundColor: tc.inputBg }]}
              >
                <Text style={[styles.helpToggleText, { color: tc.secondaryText }]}>?</Text>
              </TouchableOpacity>
            </View>
          </View>
          <TextInput
            ref={inputRef}
            style={[styles.input, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
            placeholder={t('quickAdd.example')}
            placeholderTextColor={placeholderColor}
            value={value}
            onChangeText={handleInputChange}
            onSubmitEditing={() => {
              void handleSave();
            }}
            returnKeyType="done"
            multiline
          />
          <QuickAddPreview entries={previewEntries} tc={tc} />
          {(initialProps.attachments?.length ?? 0) > 0 && (
            <View style={styles.fieldGroup}>
              <Text style={[styles.fieldLabel, { color: tc.secondaryText }]}>{tFallback(t, 'attachments.title', 'Attachments')}</Text>
              {(initialProps.attachments ?? []).map((attachment) => (
                <View key={attachment.id} style={styles.attachmentRow}>
                  <Ionicons name="attach" size={14} color={tc.secondaryText} />
                  <Text style={[styles.attachmentTitle, { color: tc.text }]} numberOfLines={1}>
                    {attachment.title}
                  </Text>
                </View>
              ))}
            </View>
          )}
          {(initialDescription.trim().length > 0 || descriptionValue.trim().length > 0) && (
            <View style={styles.fieldGroup}>
              <Text style={[styles.fieldLabel, { color: tc.secondaryText }]}>{t('taskEdit.descriptionLabel')}</Text>
              <TextInput
                style={[styles.descriptionInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                placeholder={t('taskEdit.descriptionPlaceholder')}
                placeholderTextColor={placeholderColor}
                value={descriptionValue}
                onChangeText={setDescriptionValue}
                multiline
              />
            </View>
          )}
          {pendingCopilotParts.length > 0 && (
            <View style={[styles.copilotPill, { borderColor: tc.border, backgroundColor: tc.inputBg }]}>
              <View style={styles.copilotChipRow}>
                <Text style={[styles.copilotText, { color: tc.text }]}>✨</Text>
                <Text style={[styles.copilotText, { color: tc.text }]}>{t('copilot.suggested')}</Text>
                {pendingCopilotParts.map((part) => (
                  <TouchableOpacity
                    key={`${part.kind}:${part.value}`}
                    accessibilityRole="button"
                    accessibilityLabel={part.value}
                    style={[styles.copilotChip, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                    onPress={() => applyCopilotParts([part])}
                  >
                    <Text style={[styles.copilotText, { color: tc.text }]}>{part.value}</Text>
                  </TouchableOpacity>
                ))}
                {pendingCopilotParts.length > 1 && (
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel={t('copilot.applyAll')}
                    style={styles.copilotApplyAll}
                    onPress={() => applyCopilotParts(pendingCopilotParts)}
                  >
                    <Text style={[styles.copilotText, { color: tc.tint }]}>{t('copilot.applyAll')}</Text>
                  </TouchableOpacity>
                )}
              </View>
              <Text style={[styles.copilotHint, { color: tc.secondaryText }]}>
                {t('copilot.applyHint')}
              </Text>
            </View>
          )}
          {hasAppliedCopilot && (
            <View style={[styles.copilotPill, { borderColor: tc.border, backgroundColor: tc.inputBg }]}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', columnGap: 4 }}>
                <Text style={[styles.copilotText, { color: tc.text }]}>✅</Text>
                <Text style={[styles.copilotText, { color: tc.text, flexShrink: 1 }]}>
                  {t('copilot.applied')}{' '}
                  {copilotContext ? `${copilotContext} ` : ''}
                  {timeEstimatesEnabled && copilotEstimate ? `${copilotEstimate}` : ''}
                  {copilotTags.length ? copilotTags.join(' ') : ''}
                </Text>
              </View>
            </View>
          )}
          {showHelp && (
            <Text style={[styles.help, { color: tc.secondaryText }]}>{formatQuickAddHelp(t('quickAdd.help'), { priorities: prioritiesEnabled })}</Text>
          )}
          <View style={styles.actions}>
            <TouchableOpacity onPress={handleCancel} style={[styles.button, styles.cancel, { backgroundColor: tc.inputBg }]}>
              <Text style={{ color: tc.text }}>{t('common.cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                void handleSave({ openAfterSave: true });
              }}
              style={[styles.button, styles.editAfterSave, { borderColor: tc.border }]}
            >
                                <Text style={{ color: tc.text }}>{t('quickAdd.saveAndEdit')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                void handleSave();
              }}
              style={[styles.button, styles.save]}
            >
              <Text style={styles.saveText}>{t('common.save')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
      {pendingBulkLines ? (
        <View
          style={styles.bulkConfirmOverlay}
          accessibilityViewIsModal
          importantForAccessibility="yes"
        >
          <Pressable
            style={styles.bulkConfirmBackdrop}
            onPress={() => setPendingBulkLines(null)}
            accessibilityRole="button"
            accessibilityLabel={t('common.cancel')}
          />
          <View style={[styles.bulkConfirmCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
            <Text style={[styles.bulkConfirmTitle, { color: tc.text }]} accessibilityRole="header">
              {formatBulkConfirmTitle(pendingBulkLines.length)}
            </Text>
            <Text style={[styles.bulkConfirmMessage, { color: tc.secondaryText }]}>
              {formatBulkConfirmMessage(pendingBulkLines)}
            </Text>
            <View style={styles.bulkConfirmActions}>
              <TouchableOpacity
                onPress={() => setPendingBulkLines(null)}
                style={styles.bulkConfirmButton}
                accessibilityRole="button"
              >
                <Text style={[styles.bulkConfirmButtonText, { color: tc.secondaryText }]}>
                  {t('common.cancel')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  const lines = pendingBulkLines;
                  setPendingBulkLines(null);
                  void createBulkTasks(lines);
                }}
                style={styles.bulkConfirmButton}
                accessibilityRole="button"
              >
                <Text style={[styles.bulkConfirmButtonText, { color: tc.tint }]}>
                  {tFallback(t, 'quickAdd.bulkConfirmCreate', 'Create tasks')}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      ) : null}
      {/* This route is presented modally, so a root-level alert never reaches
          the screen on iOS (#940). */}
      <ThemedAlertHost />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    padding: 16,
    justifyContent: 'center',
  },
  card: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    gap: 12,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
  },
  dismissKeyboardButton: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  helpToggle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  helpToggleText: {
    fontSize: 14,
    fontWeight: '700',
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    minHeight: 80,
  },
  help: {
    fontSize: 12,
  },
  fieldGroup: {
    gap: 6,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  descriptionInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    minHeight: 70,
  },
  attachmentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: 6,
  },
  attachmentTitle: {
    flex: 1,
    fontSize: 14,
  },
  copilotPill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignSelf: 'flex-start',
    gap: 2,
  },
  copilotChipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    columnGap: 6,
    rowGap: 6,
  },
  copilotChip: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  copilotApplyAll: {
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  copilotText: {
    fontSize: 12,
    fontWeight: '600',
  },
  copilotHint: {
    fontSize: 11,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
  },
  button: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
  },
  cancel: {},
  bulkConfirmOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
    backgroundColor: 'rgba(0,0,0,0.35)',
    zIndex: 2,
    elevation: 2,
  },
  bulkConfirmBackdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  bulkConfirmCard: {
    width: '100%',
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
  },
  bulkConfirmTitle: {
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 8,
  },
  bulkConfirmMessage: {
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 12,
  },
  bulkConfirmActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
  },
  bulkConfirmButton: {
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  bulkConfirmButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  save: {
    backgroundColor: '#3B82F6',
  },
  editAfterSave: {
    borderWidth: 1,
  },
  saveText: {
    color: '#fff',
    fontWeight: '600',
  },
});
