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
  const tokenPlaceholder = showContextsField && !showTagsField
    ? '@home'
    : showTagsField && !showContextsField
      ? '#deep-work'
      : t('inbox.addContextPlaceholder');

  return (
    <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
      <Text style={[styles.stepQuestion, { color: tc.text }]}>
        {showContextsField ? t('inbox.whereDoIt') : t('taskEdit.tagsLabel')}
        {showContextsField && showTagsField ? ` ${t('inbox.selectMultipleHint')}` : ''}
      </Text>
      {showContextsField && selectedContexts.length > 0 && (
        <View style={[styles.selectedContextsContainer, { backgroundColor: '#3B82F620' }]}>
          <Text style={{ fontSize: 12, color: '#3B82F6', marginBottom: 4 }}>{t('inbox.selectedLabel')}</Text>
          <View style={styles.selectedTokensRow}>
            {selectedContexts.map((ctx) => (
              <TouchableOpacity
                key={ctx}
                onPress={() => toggleContext(ctx)}
                style={[styles.selectedTokenChip, styles.selectedContextChip]}
              >
                <Text style={styles.selectedTokenText}>{ctx} x</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}
      {showTagsField && selectedTags.length > 0 && (
        <View style={[styles.selectedContextsContainer, { backgroundColor: '#8B5CF620' }]}>
          <Text style={{ fontSize: 12, color: '#8B5CF6', marginBottom: 4 }}>{t('taskEdit.tagsLabel')}</Text>
          <View style={styles.selectedTokensRow}>
            {selectedTags.map((tag) => (
              <TouchableOpacity
                key={tag}
                onPress={() => toggleTag(tag)}
                style={[styles.selectedTokenChip, styles.selectedTagChip]}
              >
                <Text style={styles.selectedTokenText}>{tag} x</Text>
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
      {showContextsField && contextCopilotSuggestions.length > 0 && (
        <View style={[styles.tokenSuggestionsContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
          <Text style={[styles.tokenSectionTitle, { color: tc.secondaryText }]}>Suggested contexts</Text>
          <View style={styles.tokenChipWrap}>
            {contextCopilotSuggestions.map((token) => (
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
      {showTagsField && tagCopilotSuggestions.length > 0 && (
        <View style={[styles.tokenSuggestionsContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
          <Text style={[styles.tokenSectionTitle, { color: tc.secondaryText }]}>Suggested tags</Text>
          <View style={styles.tokenChipWrap}>
            {tagCopilotSuggestions.map((token) => (
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
