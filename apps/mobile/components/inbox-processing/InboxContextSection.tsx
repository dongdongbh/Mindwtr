import React from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';

import { styles } from '../inbox-processing-modal.styles';
import type { ThemeColors } from '@/hooks/use-theme-colors';

type Props = {
  t: (key: string) => string;
  tc: ThemeColors;
  show: boolean;
  showContextsField: boolean;
  showTagsField: boolean;
  selectedContexts: string[];
  selectedTags: string[];
  toggleContext: (ctx: string) => void;
  toggleTag: (tag: string) => void;
  newContext: string;
  setNewContext: (v: string) => void;
  addCustomContextMobile: () => void;
  tokenSuggestions: string[];
  applyTokenSuggestion: (token: string) => void;
  contextCopilotSuggestions: string[];
  tagCopilotSuggestions: string[];
};

export function InboxContextSection({
  t,
  tc,
  show,
  showContextsField,
  showTagsField,
  selectedContexts,
  selectedTags,
  toggleContext,
  toggleTag,
  newContext,
  setNewContext,
  addCustomContextMobile,
  tokenSuggestions,
  applyTokenSuggestion,
  contextCopilotSuggestions,
  tagCopilotSuggestions,
}: Props) {
  if (!show) return null;

  const visibleTokenSuggestions = tokenSuggestions.filter((token) => (
    token.startsWith('#') ? showTagsField : showContextsField
  ));
  const visibleTokenSuggestionSet = new Set(visibleTokenSuggestions);
  const visibleContextCopilotSuggestions = contextCopilotSuggestions.filter((token) => !visibleTokenSuggestionSet.has(token));
  const visibleTagCopilotSuggestions = tagCopilotSuggestions.filter((token) => !visibleTokenSuggestionSet.has(token));
  const tokenPlaceholder = showContextsField && !showTagsField
    ? '@home'
    : showTagsField && !showContextsField
      ? '#deep-work'
      : t('inbox.addContextPlaceholder');
  const suggestedContextsLabel = `${t('copilot.suggested')} ${t('nav.contexts').toLowerCase()}`;
  const suggestedTagsLabel = `${t('copilot.suggested')} ${t('taskEdit.tagsLabel').toLowerCase()}`;

  return (
    <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
      <Text style={[styles.stepQuestion, { color: tc.text }]}>
        {showContextsField ? t('inbox.whereDoIt') : t('taskEdit.tagsLabel')}
        {showContextsField && showTagsField ? ` ${t('inbox.selectMultipleHint')}` : ''}
      </Text>
      {showContextsField && selectedContexts.length > 0 && (
        <View style={[styles.selectedContextsContainer, { backgroundColor: tc.filterBg }]}>
          <Text style={{ fontSize: 12, color: tc.tint, marginBottom: 4 }}>{t('inbox.selectedLabel')}</Text>
          <View style={styles.selectedTokensRow}>
            {selectedContexts.map((ctx) => (
              <TouchableOpacity
                key={ctx}
                onPress={() => toggleContext(ctx)}
                style={[styles.selectedTokenChip, styles.selectedContextChip, { backgroundColor: tc.tint }]}
              >
                <Text style={[styles.selectedTokenText, { color: tc.onTint }]}>{ctx} x</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}
      {showTagsField && selectedTags.length > 0 && (
        <View style={[styles.selectedContextsContainer, { backgroundColor: tc.filterBg }]}>
          <Text style={{ fontSize: 12, color: tc.tint, marginBottom: 4 }}>{t('taskEdit.tagsLabel')}</Text>
          <View style={styles.selectedTokensRow}>
            {selectedTags.map((tag) => (
              <TouchableOpacity
                key={tag}
                onPress={() => toggleTag(tag)}
                style={[styles.selectedTokenChip, styles.selectedTagChip, { backgroundColor: tc.tint }]}
              >
                <Text style={[styles.selectedTokenText, { color: tc.onTint }]}>{tag} x</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}
      <View style={styles.customContextContainer}>
        <TextInput
          style={[styles.contextInput, { borderColor: tc.border, color: tc.text }]}
          placeholder={tokenPlaceholder}
          placeholderTextColor={tc.secondaryText}
          value={newContext}
          onChangeText={setNewContext}
          onSubmitEditing={addCustomContextMobile}
        />
        <TouchableOpacity
          style={styles.addContextButton}
          onPress={addCustomContextMobile}
          disabled={!newContext.trim()}
        >
          <Text style={styles.addContextButtonText}>+</Text>
        </TouchableOpacity>
      </View>
      {visibleTokenSuggestions.length > 0 && (
        <View style={[styles.tokenSuggestionsContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
          {visibleTokenSuggestions.map((token) => (
            <TouchableOpacity
              key={token}
              style={styles.tokenSuggestionChip}
              onPress={() => applyTokenSuggestion(token)}
            >
              <Text style={[styles.tokenSuggestionText, { color: tc.text }]}>{token}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
      {showContextsField && visibleContextCopilotSuggestions.length > 0 && (
        <View style={[styles.tokenSuggestionsContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
          <Text style={[styles.tokenSectionTitle, { color: tc.secondaryText }]}>{suggestedContextsLabel}</Text>
          <View style={styles.tokenChipWrap}>
            {visibleContextCopilotSuggestions.map((token) => (
              <TouchableOpacity
                key={`ctx-${token}`}
                style={[styles.suggestionChip, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                onPress={() => applyTokenSuggestion(token)}
              >
                <Text style={[styles.tokenSuggestionText, { color: tc.text }]}>{token}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}
      {showTagsField && visibleTagCopilotSuggestions.length > 0 && (
        <View style={[styles.tokenSuggestionsContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
          <Text style={[styles.tokenSectionTitle, { color: tc.secondaryText }]}>{suggestedTagsLabel}</Text>
          <View style={styles.tokenChipWrap}>
            {visibleTagCopilotSuggestions.map((token) => (
              <TouchableOpacity
                key={`tag-${token}`}
                style={[styles.suggestionChip, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                onPress={() => applyTokenSuggestion(token)}
              >
                <Text style={[styles.tokenSuggestionText, { color: tc.text }]}>{token}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}
    </View>
  );
}
