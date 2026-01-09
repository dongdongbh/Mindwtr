import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { createAIProvider, PRESET_CONTEXTS, PRESET_TAGS, parseQuickAdd, type Task, type TimeEstimate, type AIProviderId, useTaskStore } from '@mindwtr/core';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useLanguage } from '../contexts/language-context';
import { buildCopilotConfig, loadAIKey } from '../lib/ai-config';

export default function CaptureScreen() {
  const params = useLocalSearchParams<{ text?: string }>();
  const router = useRouter();
  const { addTask, projects, tasks, settings } = useTaskStore();
  const tc = useThemeColors();
  const { t } = useLanguage();
  const initialText = typeof params.text === 'string' ? decodeURIComponent(params.text) : '';
  const [value, setValue] = useState(initialText);
  const [copilotSuggestion, setCopilotSuggestion] = useState<{ context?: string; timeEstimate?: TimeEstimate; tags?: string[] } | null>(null);
  const [copilotApplied, setCopilotApplied] = useState(false);
  const [aiKey, setAiKey] = useState('');
  const [copilotContext, setCopilotContext] = useState<string | undefined>(undefined);
  const [copilotEstimate, setCopilotEstimate] = useState<TimeEstimate | undefined>(undefined);
  const [copilotTags, setCopilotTags] = useState<string[]>([]);
  const [showHelp, setShowHelp] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const copilotMountedRef = useRef(true);
  const copilotAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 120);
  }, []);

  useEffect(() => {
    if (typeof params.text === 'string') {
      setValue(decodeURIComponent(params.text));
    }
  }, [params.text]);

  const aiEnabled = settings.ai?.enabled === true;
  const aiProvider = (settings.ai?.provider ?? 'openai') as AIProviderId;
  const timeEstimatesEnabled = settings.features?.timeEstimates === true;

  useEffect(() => {
    loadAIKey(aiProvider).then(setAiKey).catch(console.error);
  }, [aiProvider]);

  const contextOptions = React.useMemo(() => {
    const taskContexts = tasks.flatMap((task) => task.contexts || []);
    return Array.from(new Set([...PRESET_CONTEXTS, ...taskContexts])).filter(Boolean);
  }, [tasks]);
  const tagOptions = React.useMemo(() => {
    const taskTags = tasks.flatMap((task) => task.tags || []);
    return Array.from(new Set([...PRESET_TAGS, ...taskTags])).filter(Boolean);
  }, [tasks]);

  useEffect(() => {
    if (!aiEnabled || !aiKey) {
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
        if (!suggestion.context && (!timeEstimatesEnabled || !suggestion.timeEstimate)) {
          setCopilotSuggestion(null);
        } else {
          setCopilotSuggestion(suggestion);
        }
      } catch (error) {
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
    settings.ai?.copilotModel,
    settings.ai?.thinkingBudget,
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
    setCopilotApplied(false);
    setCopilotContext(undefined);
    setCopilotEstimate(undefined);
    setCopilotTags([]);
  };

  const placeholderColor = tc.secondaryText;

  const handleSave = () => {
    if (!value.trim()) return;
    const { title, props } = parseQuickAdd(value, projects);
    const finalTitle = title || value;
    if (!finalTitle.trim()) return;
    const initialProps: Partial<Task> = { status: 'inbox', ...props };
    if (!props.status) initialProps.status = 'inbox';
    if (copilotContext) {
      const nextContexts = Array.from(new Set([...(initialProps.contexts ?? []), copilotContext]));
      initialProps.contexts = nextContexts;
    }
    if (timeEstimatesEnabled && copilotEstimate && !initialProps.timeEstimate) {
      initialProps.timeEstimate = copilotEstimate;
    }
    if (copilotTags.length) {
      const nextTags = Array.from(new Set([...(initialProps.tags ?? []), ...copilotTags]));
      initialProps.tags = nextTags;
    }
    addTask(finalTitle, initialProps);
    router.replace('/inbox');
  };

  return (
    <View style={[styles.container, { backgroundColor: tc.bg }]}>
      <View style={[styles.card, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
        <View style={styles.titleRow}>
          <Text style={[styles.title, { color: tc.text }]}>{t('nav.addTask')}</Text>
          <TouchableOpacity
            onPress={() => setShowHelp((prev) => !prev)}
            style={[styles.helpToggle, { borderColor: tc.border, backgroundColor: tc.inputBg }]}
          >
            <Text style={[styles.helpToggleText, { color: tc.secondaryText }]}>?</Text>
          </TouchableOpacity>
        </View>
        <TextInput
          ref={inputRef}
          style={[styles.input, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
          placeholder={t('quickAdd.example')}
          placeholderTextColor={placeholderColor}
          value={value}
          onChangeText={handleInputChange}
          onSubmitEditing={handleSave}
          returnKeyType="done"
          multiline
        />
        {copilotSuggestion && !copilotApplied && (
          <TouchableOpacity
            style={[styles.copilotPill, { borderColor: tc.border, backgroundColor: tc.inputBg }]}
            onPress={() => {
              setCopilotContext(copilotSuggestion.context);
              if (timeEstimatesEnabled) setCopilotEstimate(copilotSuggestion.timeEstimate);
              setCopilotTags(copilotSuggestion.tags ?? []);
              setCopilotApplied(true);
            }}
          >
            <Text style={[styles.copilotText, { color: tc.text }]}>
              ✨ {t('copilot.suggested')}{' '}
              {copilotSuggestion.context ? `${copilotSuggestion.context} ` : ''}
              {timeEstimatesEnabled && copilotSuggestion.timeEstimate ? `${copilotSuggestion.timeEstimate}` : ''}
              {copilotSuggestion.tags?.length ? copilotSuggestion.tags.join(' ') : ''}
            </Text>
            <Text style={[styles.copilotHint, { color: tc.secondaryText }]}>
              {t('copilot.applyHint')}
            </Text>
          </TouchableOpacity>
        )}
        {copilotApplied && (
          <View style={[styles.copilotPill, { borderColor: tc.border, backgroundColor: tc.inputBg }]}>
            <Text style={[styles.copilotText, { color: tc.text }]}>
              ✅ {t('copilot.applied')}{' '}
              {copilotContext ? `${copilotContext} ` : ''}
              {timeEstimatesEnabled && copilotEstimate ? `${copilotEstimate}` : ''}
              {copilotTags.length ? copilotTags.join(' ') : ''}
            </Text>
          </View>
        )}
        {showHelp && (
          <Text style={[styles.help, { color: tc.secondaryText }]}>{t('quickAdd.help')}</Text>
        )}
        <View style={styles.actions}>
          <TouchableOpacity onPress={() => router.back()} style={[styles.button, styles.cancel, { backgroundColor: tc.inputBg }]}>
            <Text style={{ color: tc.text }}>{t('common.cancel')}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={handleSave} style={[styles.button, styles.save]}>
            <Text style={styles.saveText}>{t('common.save')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
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
  title: {
    fontSize: 20,
    fontWeight: '600',
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
  copilotPill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignSelf: 'flex-start',
    gap: 2,
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
  save: {
    backgroundColor: '#3B82F6',
  },
  saveText: {
    color: '#fff',
    fontWeight: '600',
  },
});
