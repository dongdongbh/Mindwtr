import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
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
import { Check, Sparkles } from 'lucide-react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useNavigation, usePreventRemove } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import {
  executeCaptureTransaction,
  buildQuickAddParseOptions,
  buildQuickAddPreviewEntries,
  createAIProvider,
  getUsedTaskTokens,
  getSavedTaxonomyTokens,
  parseQuickAdd,
  resolveDefaultNewTaskAreaId,
  formatQuickAddHelp,
  resolveFeatureFlags,
  shallow,
  splitQuickAddBulkLines,
  tFallback,
  type AIProviderId,
  type Attachment,
  type Language,
  type Project,
  type TimeEstimate,
  useTaskStore,
} from '@mindwtr/core';
import {
  applyCaptureModalCopilotParts,
  buildCaptureModalRequest,
  formatCaptureModalCopilotApplied,
  getCaptureModalBulkConfirm,
  getCaptureModalCloseTarget,
  getCaptureModalCopilotParts,
  keepCaptureModalCopilotSuggestion,
  readCaptureModalInitialProps,
  readCaptureModalInitialText,
  readCaptureModalOrigin,
  readCaptureModalProjectParam,
  resolveCaptureModalAfterSave,
  sanitizeCaptureReturnToParam,
  saveCaptureModalLines,
  shouldRequestCaptureModalCopilot,
  type CaptureModalCopilotPart,
  type CaptureModalParams,
} from '@mindwtr/core/capture-modal-model';
import { canUploadAttachmentFrom, getAttachmentsDir } from '@/lib/attachment-sync-utils';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useToast } from '@/contexts/toast-context';
import { useLanguage } from '../contexts/language-context';
import { buildCopilotConfig, isAIKeyRequired, loadAIKey } from '../lib/ai-config';
import { logError, logInfo } from '../lib/app-log';
import { logIosShareDiagnostic } from '../lib/share-intent-diagnostics';
import { addHardwareBackPressListener, returnToPreviousApp } from '@/lib/hardware-back';
import { showInvalidDateCommandToast } from '@/lib/quick-add-toast';
import { ThemedAlertHost } from '@/components/themed-alert';
import { SandboxWorkspaceCue } from '@/components/sandbox-workspace-cue';
import { QuickAddPreview } from '@/components/QuickAddPreview';
import { openTaskScreen, stashPendingCaptureTaskOpen } from '@/lib/task-meta-navigation';
import { markCaptureRouteMounted } from '@/lib/capture-route-presence';

// The route params, and every rule about them, are core's (capture-modal-model.ts).
export { sanitizeCaptureReturnToParam };

const filterManagedAttachments = async (attachments: Attachment[]): Promise<Attachment[]> => {
  const dir = await getAttachmentsDir();
  if (!dir) return [];
  return attachments.filter((attachment) => canUploadAttachmentFrom(attachment.uri));
};

export default function CaptureScreen() {
  const params = useLocalSearchParams<CaptureModalParams>();
  const router = useRouter();
  const navigation = useNavigation();
  const { addProject, addTask, addTasks, projects, tasks, allTasks, settings, areas, people } = useTaskStore((state) => ({
    addProject: state.addProject,
    addTask: state.addTask,
    addTasks: state.addTasks,
    projects: state.projects,
    tasks: state.tasks,
    allTasks: state._allTasks,
    settings: state.settings,
    areas: state.areas,
    people: state.people,
  }), shallow);
  const tc = useThemeColors();
  const { showToast } = useToast();
  const { t, language } = useLanguage();
  const initialText = readCaptureModalInitialText(params);
  const initialProps = React.useMemo(
    () => readCaptureModalInitialProps(params.initialProps, projects, areas),
    [areas, params.initialProps, projects]
  );
  const defaultNewTaskAreaId = resolveDefaultNewTaskAreaId(settings, areas);
  const returnTo = React.useMemo(
    () => sanitizeCaptureReturnToParam(params.returnTo),
    [params.returnTo]
  );
  const initialDescription = String(initialProps.description ?? '');
  const initialProjectTitle = readCaptureModalProjectParam(params);
  const [value, setValue] = useState(initialText);
  const [pendingBulkLines, setPendingBulkLines] = useState<string[] | null>(null);
  const [descriptionValue, setDescriptionValue] = useState(initialDescription);
  const [copilotSuggestion, setCopilotSuggestion] = useState<{ language: Language; context?: string; timeEstimate?: TimeEstimate; tags?: string[] } | null>(null);
  const visibleCopilotSuggestion = copilotSuggestion?.language === language ? copilotSuggestion : null;
  const [aiKey, setAiKey] = useState('');
  const [copilotContext, setCopilotContext] = useState<string | undefined>(undefined);
  const [copilotEstimate, setCopilotEstimate] = useState<TimeEstimate | undefined>(undefined);
  const [copilotTags, setCopilotTags] = useState<string[]>([]);
  const [showHelp, setShowHelp] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [captureError, setCaptureError] = useState<{ message: string } | null>(null);
  const inputRef = useRef<TextInput>(null);
  const submissionInFlightRef = useRef(false);
  const allowCaptureRemovalRef = useRef(false);
  const screenMountedRef = useRef(true);
  const copilotMountedRef = useRef(true);
  const copilotAbortRef = useRef<AbortController | null>(null);

  // Screens under capture wait for this before presenting a modal (iOS, see capture-route-presence).
  useEffect(() => markCaptureRouteMounted(), []);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 120);
  }, []);

  useEffect(() => {
    screenMountedRef.current = true;
    return () => {
      screenMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'android' || !captureError || isSubmitting) return;
    const announcement = captureError.message;
    const handle = setTimeout(() => {
      if (!screenMountedRef.current || submissionInFlightRef.current) return;
      AccessibilityInfo.announceForAccessibility(announcement);
      void logInfo('Capture failure accessibility announcement requested', {
        scope: 'capture',
        extra: { releaseCheck: 'v1.3.0/capture-failure-announcement' },
      });
    }, 0);
    return () => clearTimeout(handle);
  }, [captureError, isSubmitting]);

  usePreventRemove(isSubmitting, ({ data }) => {
    if (!allowCaptureRemovalRef.current || !screenMountedRef.current) return;
    navigation.dispatch(data.action);
  });

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
    return Array.from(new Set([...getUsedTaskTokens(tasks, (task) => task.contexts, { prefix: '@' }), ...getSavedTaxonomyTokens(settings, 'context')]));
  }, [tasks, settings]);
  const tagOptions = React.useMemo(() => {
    return Array.from(new Set([...getUsedTaskTokens(tasks, (task) => task.tags, { prefix: '#' }), ...getSavedTaxonomyTokens(settings, 'tag')]));
  }, [tasks, settings]);
  const quickAddParseOptions = React.useMemo(
    () => buildQuickAddParseOptions(settings, { tasks, _allTasks: allTasks, people }),
    [allTasks, people, settings, tasks]
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
    const title = value.trim();
    if (!shouldRequestCaptureModalCopilot({ aiEnabled, keyRequired, hasKey: Boolean(aiKey), title })) {
      setCopilotSuggestion(null);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        if (copilotAbortRef.current) copilotAbortRef.current.abort();
        const abortController = typeof AbortController === 'function' ? new AbortController() : null;
        copilotAbortRef.current = abortController;
        const provider = createAIProvider(buildCopilotConfig(settings, aiKey, language));
        const suggestion = await provider.predictMetadata(
          { title, contexts: contextOptions, tags: tagOptions },
          abortController ? { signal: abortController.signal } : undefined
        );
        if (cancelled || !copilotMountedRef.current) return;
        const kept = keepCaptureModalCopilotSuggestion(suggestion, timeEstimatesEnabled);
        setCopilotSuggestion(kept ? { ...kept, language } : null);
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
    language,
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
  const appliedCopilot = { context: copilotContext, timeEstimate: copilotEstimate, tags: copilotTags };
  const pendingCopilotParts = getCaptureModalCopilotParts(visibleCopilotSuggestion, appliedCopilot, timeEstimatesEnabled);
  const appliedCopilotText = formatCaptureModalCopilotApplied(t, appliedCopilot, timeEstimatesEnabled);

  const applyCopilotParts = (parts: CaptureModalCopilotPart[]) => {
    const next = applyCaptureModalCopilotParts(appliedCopilot, parts, timeEstimatesEnabled);
    setCopilotContext(next.context);
    setCopilotEstimate(next.timeEstimate);
    setCopilotTags(next.tags);
  };

  const placeholderColor = tc.secondaryText;

  const origin = readCaptureModalOrigin(params);
  const launchedFromSystem = origin === 'system';
  const launchedFromShare = origin === 'share';

  useEffect(() => {
    if (!launchedFromShare) return;
    logIosShareDiagnostic({ stage: 'form-mounted' });
  }, [launchedFromShare]);

  const closeCapture = React.useCallback(() => {
    if (!screenMountedRef.current) return;
    // A real back entry always wins: the screen underneath is the one that
    // opened capture, still holding the open project. Replacing capture with
    // returnTo instead left a duplicate screen on the stack after every save,
    // so leaving a project took one back tap per task added (#938). returnTo
    // stays as the fallback for a capture with nothing behind it (a restored
    // session that reopened straight into the capture route).
    const target = getCaptureModalCloseTarget(router.canGoBack(), returnTo);
    if (target === 'back') {
      router.back();
      return;
    }
    router.replace(target as never);
  }, [returnTo, router]);

  // A capture that a widget, tile, shortcut or notification opened ends back
  // on the screen the user came from, not on Mindwtr (#1169). Save & edit is
  // the one exception: the user asked to stay in the editor.
  const finishCapture = React.useCallback(() => {
    if (!screenMountedRef.current) return;
    closeCapture();
    if (!launchedFromSystem) return;
    if (returnToPreviousApp()) {
      void logInfo('Quick capture opened from a system entry point returned to the previous screen', {
        scope: 'capture',
      });
    }
  }, [closeCapture, launchedFromSystem]);

  const handleCancel = () => {
    if (submissionInFlightRef.current) return;
    if (launchedFromShare) logIosShareDiagnostic({ stage: 'cancel', type: 'single' });
    finishCapture();
  };

  const beginSubmission = () => {
    if (submissionInFlightRef.current) return false;
    submissionInFlightRef.current = true;
    allowCaptureRemovalRef.current = false;
    setIsSubmitting(true);
    setCaptureError(null);
    return true;
  };

  const endSubmission = () => {
    submissionInFlightRef.current = false;
    // A native-stack removal triggered by success can reach the hook after the
    // write promise settles. Keep that one removal authorized until unmount or
    // until beginSubmission takes ownership of a new capture attempt.
    if (screenMountedRef.current) setIsSubmitting(false);
  };

  const showCaptureFailure = () => {
    if (!screenMountedRef.current) return;
    setCaptureError({
      message: tFallback(t, 'task.addFailed', 'Failed to add task'),
    });
  };

  const buildCaptureRequestFromInput = async (
    inputValue: string,
    currentProjects: readonly Project[] = projects,
  ): Promise<ReturnType<typeof buildCaptureModalRequest> | null> => {
    if (!inputValue.trim()) return null;
    // Invalid date commands are not checked here: prepareCaptureTask rejects
    // them with a typed reason, so the warning is raised once, where the write
    // actually fails.
    const parsed = parseQuickAdd(inputValue, currentProjects as Project[], new Date(), areas, quickAddParseOptions);
    // Shared files are saved only from the app's own attachments folder.
    const surfaceProps = { ...initialProps };
    if (surfaceProps.attachments?.length) {
      const managed = await filterManagedAttachments(surfaceProps.attachments);
      if (managed.length > 0) {
        surfaceProps.attachments = managed;
      } else {
        delete surfaceProps.attachments;
      }
    }
    return buildCaptureModalRequest({
      parsed,
      text: inputValue,
      projects: currentProjects,
      initialProps: surfaceProps,
      projectParam: initialProjectTitle,
      defaultAreaId: defaultNewTaskAreaId,
      description: descriptionValue,
      copilot: appliedCopilot,
      timeEstimatesEnabled,
    });
  };

  const createTaskFromInput = async (
    inputValue: string,
    { openAfterSave = false }: { openAfterSave?: boolean } = {},
  ): Promise<boolean> => {
    let request: Awaited<ReturnType<typeof buildCaptureRequestFromInput>>;
    try {
      request = await buildCaptureRequestFromInput(inputValue);
    } catch {
      if (launchedFromShare) {
        logIosShareDiagnostic({ stage: 'submit-rejected', type: 'single', outcome: 'prepare-failed' });
      }
      showCaptureFailure();
      return false;
    }
    if (!request) {
      if (launchedFromShare) {
        logIosShareDiagnostic({ stage: 'submit-rejected', type: 'single', outcome: 'validation-rejected' });
      }
      return false;
    }
    let result: Awaited<ReturnType<typeof executeCaptureTransaction>>;
    try {
      result = await executeCaptureTransaction(
        request.input,
        { addProject, addTask },
        request.options,
      );
    } catch {
      if (launchedFromShare) {
        logIosShareDiagnostic({ stage: 'submit-rejected', type: 'single', outcome: 'transaction-threw' });
      }
      showCaptureFailure();
      return false;
    }
    if (!result.success) {
      if (launchedFromShare) {
        logIosShareDiagnostic({
          stage: 'submit-rejected',
          type: 'single',
          outcome: result.reason === 'invalid-date-command' ? 'validation-rejected' : 'transaction-rejected',
        });
      }
      if (!screenMountedRef.current) return false;
      if (result.reason === 'invalid-date-command') {
        showInvalidDateCommandToast(showToast, t, result.invalidDateCommands);
      } else {
        showCaptureFailure();
      }
      return false;
    }
    if (launchedFromShare) {
      logIosShareDiagnostic({ stage: 'transaction-returned', type: 'single', outcome: 'success', count: 1 });
    }
    if (!screenMountedRef.current) return false;
    const after = resolveCaptureModalAfterSave({
      openAfterSave,
      taskId: result.createdTaskId,
      projectId: result.props.projectId,
      returnTo,
      origin,
    });
    if (after.kind === 'close') return true;
    // Leave this route, don't push over it: the capture screen must not
    // stay on the stack holding the saved text, or backing out of the
    // editor reopens it pre-filled (#1029).
    allowCaptureRemovalRef.current = true;
    if (after.kind === 'openInProject') {
      // Opened from this project's own + button, so the project screen is
      // what capture closes back to. Navigating to it would stack a
      // duplicate of it (#938 trap — an extra back tap through an
      // identical page); stash the editor request for the screen's focus
      // effect and close exactly like a plain save.
      stashPendingCaptureTaskOpen({ taskId: after.taskId, projectId: after.projectId, taskTab: 'task' });
      closeCapture();
    } else {
      openTaskScreen(after.taskId, after.projectId, 'task', { replace: true });
    }
    return false;
  };

  const createBulkTasks = async (lines: string[]) => {
    let thrownOutcome: 'prepare-failed' | 'transaction-threw' = 'prepare-failed';
    try {
      const outcome = await saveCaptureModalLines({
        lines,
        projects,
        buildRequest: buildCaptureRequestFromInput,
        actions: { addProject, addTasks },
        onWrite: () => { thrownOutcome = 'transaction-threw'; },
      });
      if (outcome.kind === 'refused') {
        if (launchedFromShare) {
          logIosShareDiagnostic({ stage: 'submit-rejected', type: 'bulk', outcome: 'validation-rejected' });
        }
        if (screenMountedRef.current) showInvalidDateCommandToast(showToast, t, outcome.invalidDateCommands);
        return;
      }
      if (outcome.kind === 'failed') {
        if (launchedFromShare) {
          logIosShareDiagnostic({ stage: 'submit-rejected', type: 'bulk', outcome: outcome.stage });
        }
        showCaptureFailure();
        return;
      }
      if (launchedFromShare) {
        logIosShareDiagnostic({ stage: 'transaction-returned', type: 'bulk', outcome: 'success', count: outcome.count });
      }
      if (!screenMountedRef.current) return;
      allowCaptureRemovalRef.current = true;
      finishCapture();
    } catch {
      if (launchedFromShare) {
        logIosShareDiagnostic({ stage: 'submit-rejected', type: 'bulk', outcome: thrownOutcome });
      }
      showCaptureFailure();
    }
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
    if (!beginSubmission()) return;
    if (launchedFromShare) {
      logIosShareDiagnostic({ stage: 'submit-started', type: 'single', count: 1 });
    }
    try {
      const shouldClose = await createTaskFromInput(value, { openAfterSave });
      if (shouldClose && screenMountedRef.current) {
        allowCaptureRemovalRef.current = true;
        finishCapture();
      }
    } finally {
      endSubmission();
    }
  };

  useEffect(() => {
    const subscription = addHardwareBackPressListener(() => {
      if (submissionInFlightRef.current) return true;
      if (!pendingBulkLines) return false;
      if (launchedFromShare) logIosShareDiagnostic({ stage: 'cancel', type: 'bulk' });
      setPendingBulkLines(null);
      return true;
    });
    return () => subscription.remove();
  }, [launchedFromShare, pendingBulkLines]);

  const bulkConfirm = pendingBulkLines ? getCaptureModalBulkConfirm(pendingBulkLines, t) : null;

  const cancelBulkCapture = () => {
    if (launchedFromShare) logIosShareDiagnostic({ stage: 'cancel', type: 'bulk' });
    setPendingBulkLines(null);
  };

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: tc.bg }]}
      // Android draws edge to edge, so the window no longer shrinks for the keyboard and it covered Cancel and Save.
      // 'height' keeps the card above it, as the task editor's form does; its frame math is relative, so a window that
      // still resizes gains nothing twice.
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        keyboardShouldPersistTaps="handled"
        accessibilityElementsHidden={Boolean(pendingBulkLines)}
        importantForAccessibility={pendingBulkLines ? 'no-hide-descendants' : 'auto'}
      >
        <View style={[styles.card, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
          <SandboxWorkspaceCue />
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
                <Sparkles size={13} color={tc.text} />
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
          {appliedCopilotText !== null && (
            <View style={[styles.copilotPill, { borderColor: tc.border, backgroundColor: tc.inputBg }]}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', columnGap: 4 }}>
                <Check size={13} color={tc.text} style={{ marginTop: 1 }} />
                <Text style={[styles.copilotText, { color: tc.text, flexShrink: 1 }]}>
                  {appliedCopilotText}
                </Text>
              </View>
            </View>
          )}
          {showHelp && (
            <Text style={[styles.help, { color: tc.secondaryText }]}>{formatQuickAddHelp(t('quickAdd.help'), { priorities: prioritiesEnabled, timeEstimates: timeEstimatesEnabled })}</Text>
          )}
          {captureError ? (
            <Text
              accessibilityLiveRegion={Platform.OS === 'android' ? undefined : 'assertive'}
              accessibilityRole={Platform.OS === 'android' ? undefined : 'alert'}
              style={[styles.captureError, { color: tc.danger }]}
            >
              {captureError.message}
            </Text>
          ) : null}
          <View style={styles.actions}>
            <TouchableOpacity
              disabled={isSubmitting}
              onPress={handleCancel}
              style={[styles.button, styles.cancel, { backgroundColor: tc.inputBg }]}
            >
              <Text style={{ color: tc.text }}>{t('common.cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              disabled={isSubmitting}
              onPress={() => {
                void handleSave({ openAfterSave: true });
              }}
              style={[styles.button, styles.editAfterSave, { borderColor: tc.border }]}
            >
                                <Text style={{ color: tc.text }}>{t('quickAdd.saveAndEdit')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              disabled={isSubmitting}
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
      {pendingBulkLines && bulkConfirm ? (
        <View
          style={styles.bulkConfirmOverlay}
          accessibilityViewIsModal
          importantForAccessibility="yes"
        >
          <Pressable
            style={styles.bulkConfirmBackdrop}
            onPress={cancelBulkCapture}
            disabled={isSubmitting}
            accessibilityRole="button"
            accessibilityLabel={t('common.cancel')}
          />
          <View style={[styles.bulkConfirmCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
            <Text style={[styles.bulkConfirmTitle, { color: tc.text }]} accessibilityRole="header">
              {bulkConfirm.title}
            </Text>
            <Text style={[styles.bulkConfirmMessage, { color: tc.secondaryText }]}>
              {bulkConfirm.message}
            </Text>
            <View style={styles.bulkConfirmActions}>
              <TouchableOpacity
                onPress={cancelBulkCapture}
                disabled={isSubmitting}
                style={styles.bulkConfirmButton}
                accessibilityRole="button"
              >
                <Text style={[styles.bulkConfirmButtonText, { color: tc.secondaryText }]}>
                  {bulkConfirm.cancelLabel}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  if (!beginSubmission()) return;
                  const lines = pendingBulkLines;
                  setPendingBulkLines(null);
                  if (launchedFromShare) {
                    logIosShareDiagnostic({ stage: 'bulk-confirmed', count: lines.length });
                    logIosShareDiagnostic({ stage: 'submit-started', type: 'bulk', count: lines.length });
                  }
                  void createBulkTasks(lines).finally(endSubmission);
                }}
                disabled={isSubmitting}
                style={styles.bulkConfirmButton}
                accessibilityRole="button"
              >
                <Text style={[styles.bulkConfirmButtonText, { color: tc.tint }]}>
                  {bulkConfirm.confirmLabel}
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
  captureError: {
    fontSize: 13,
    lineHeight: 18,
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
