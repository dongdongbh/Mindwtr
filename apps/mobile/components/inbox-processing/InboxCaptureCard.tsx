import React from 'react';
import type { RefObject } from 'react';
import { ActivityIndicator, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { ChevronDown, ChevronUp, Hourglass, Sparkles } from 'lucide-react-native';
import { stripMarkdown, tFallback } from '@mindwtr/core';

import { styles } from '../inbox-processing-modal.styles';
import type { ThemeColors } from '@/hooks/use-theme-colors';

const NOTE_PREVIEW_LIMIT = 200;

type Props = {
  t: (key: string) => string;
  tc: ThemeColors;
  titleInputRef: RefObject<TextInput>;
  processingTitle: string;
  setProcessingTitle: (v: string) => void;
  processingDescription: string;
  setProcessingDescription: (v: string) => void;
  processingTitleFocused: boolean;
  setProcessingTitleFocused: (v: boolean) => void;
  titleDirectionStyle: object;
  aiEnabled: boolean;
  isAIWorking: boolean;
  handleAIClarifyInbox: () => void;
  aiWorkingText: string;
  notesOpen: boolean;
  setNotesOpen: (v: boolean) => void;
  /** This item reached the pass from Someday, not the Inbox (#1089). */
  isReturningItem: boolean;
};

/**
 * The item, anchored above every processing step. Clarifying a capture is part
 * of processing it, so the title is editable in place at all times; the note
 * and AI clarify sit one explicit tap away instead of crowding every step.
 */
export function InboxCaptureCard({
  t,
  tc,
  titleInputRef,
  processingTitle,
  setProcessingTitle,
  processingDescription,
  setProcessingDescription,
  processingTitleFocused,
  setProcessingTitleFocused,
  titleDirectionStyle,
  aiEnabled,
  isAIWorking,
  handleAIClarifyInbox,
  aiWorkingText,
  notesOpen,
  setNotesOpen,
  isReturningItem,
}: Props) {
  const notePreview = stripMarkdown(processingDescription).trim().slice(0, NOTE_PREVIEW_LIMIT);

  return (
    <View style={[styles.anchorCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
      {isReturningItem ? (
        <View style={styles.anchorActionsRow}>
          <Hourglass size={13} color={tc.secondaryText} />
          <Text style={[styles.anchorActionText, { color: tc.secondaryText }]}>
            {tFallback(t, 'process.returningItem', 'Back to clarify')}
          </Text>
        </View>
      ) : null}

      <TextInput
        ref={titleInputRef}
        style={[styles.anchorTitleInput, titleDirectionStyle, { color: tc.text }]}
        value={processingTitle}
        onChangeText={setProcessingTitle}
        placeholder={t('taskEdit.titleLabel')}
        placeholderTextColor={tc.secondaryText}
        accessibilityLabel={t('taskEdit.titleLabel')}
        onFocus={() => setProcessingTitleFocused(true)}
        onBlur={() => setProcessingTitleFocused(false)}
        selection={processingTitleFocused ? undefined : { start: 0, end: 0 }}
        multiline
      />

      {!notesOpen && notePreview ? (
        <Text style={[styles.anchorNote, { color: tc.secondaryText }]} numberOfLines={2}>
          {notePreview}
        </Text>
      ) : null}

      <View style={styles.anchorActionsRow}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={t('taskEdit.descriptionLabel')}
          accessibilityState={{ expanded: notesOpen }}
          style={styles.anchorActionButton}
          onPress={() => setNotesOpen(!notesOpen)}
          hitSlop={6}
        >
          <Text style={[styles.anchorActionText, { color: tc.tint }]}>
            {t('taskEdit.descriptionLabel')}
          </Text>
          {notesOpen
            ? <ChevronUp size={14} color={tc.tint} />
            : <ChevronDown size={14} color={tc.tint} />}
        </TouchableOpacity>
        {aiEnabled && (
          <TouchableOpacity
            accessibilityRole="button"
            style={styles.anchorActionButton}
            onPress={handleAIClarifyInbox}
            disabled={isAIWorking}
            accessibilityState={{ disabled: isAIWorking, busy: isAIWorking }}
            hitSlop={6}
          >
            {isAIWorking
              ? <ActivityIndicator size="small" color={tc.tint} />
              : <Sparkles size={14} color={tc.tint} />}
            <Text style={[styles.anchorActionText, { color: tc.tint }]}>
              {isAIWorking ? aiWorkingText : t('taskEdit.aiClarify')}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {notesOpen && (
        <>
          <TextInput
            style={[styles.refineDescriptionInput, { borderColor: tc.border, color: tc.text, backgroundColor: tc.bg }]}
            value={processingDescription}
            onChangeText={setProcessingDescription}
            placeholder={t('taskEdit.descriptionPlaceholder')}
            placeholderTextColor={tc.secondaryText}
            multiline
            numberOfLines={4}
          />
          <Text style={[styles.anchorNote, { color: tc.secondaryText }]}>
            {tFallback(t, 'inbox.refineHint', 'Clarify the title and details before deciding what to do next.')}
          </Text>
        </>
      )}
    </View>
  );
}
