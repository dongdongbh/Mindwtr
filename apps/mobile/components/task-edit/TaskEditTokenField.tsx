import React from 'react';
import { Keyboard, Text, TextInput, TouchableOpacity, View } from 'react-native';

import type { TaskEditFieldRendererProps } from './TaskEditFieldRenderer.types';

type TokenFieldId = 'contexts' | 'tags';

type TaskEditTokenFieldProps = TaskEditFieldRendererProps & {
    fieldId: TokenFieldId;
};

export function TaskEditTokenField({
    applyContextSuggestion,
    applyTagSuggestion,
    commitContextDraft,
    commitTagDraft,
    contextInputDraft,
    contextTokenSuggestions,
    fieldId,
    frequentContextSuggestions,
    frequentTagSuggestions,
    handleInputFocus,
    selectedContextTokens,
    selectedTagTokens,
    setIsContextInputFocused,
    setIsTagInputFocused,
    styles,
    t,
    tc,
    tagInputDraft,
    tagTokenSuggestions,
    toggleQuickContextToken,
    toggleQuickTagToken,
    updateContextInput,
    updateTagInput,
}: TaskEditTokenFieldProps) {
    const inputStyle = { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text };
    const getQuickTokenChipStyle = (active: boolean) => ([
        styles.quickTokenChip,
        { backgroundColor: active ? tc.tint : tc.filterBg, borderColor: active ? tc.tint : tc.border },
    ]);
    const getQuickTokenTextStyle = (active: boolean) => ([
        styles.quickTokenText,
        { color: active ? '#fff' : tc.secondaryText },
    ]);

    if (fieldId === 'contexts') {
        return (
            <View style={styles.formGroup}>
                <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.contextsLabel')}</Text>
                <TextInput
                    style={[styles.input, inputStyle]}
                    value={contextInputDraft}
                    onChangeText={updateContextInput}
                    onFocus={(event) => {
                        setIsContextInputFocused(true);
                        handleInputFocus(event.nativeEvent.target);
                    }}
                    onBlur={commitContextDraft}
                    onSubmitEditing={() => {
                        commitContextDraft();
                        Keyboard.dismiss();
                    }}
                    returnKeyType="done"
                    blurOnSubmit
                    placeholder={t('taskEdit.contextsPlaceholder')}
                    autoCapitalize="none"
                    placeholderTextColor={tc.secondaryText}
                    accessibilityLabel={t('taskEdit.contextsLabel')}
                    accessibilityHint={t('taskEdit.contextsPlaceholder')}
                />
                {contextTokenSuggestions.length > 0 && (
                    <View style={[styles.tokenSuggestionsMenu, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                        {contextTokenSuggestions.map((token, index) => (
                            <TouchableOpacity
                                key={token}
                                style={[
                                    styles.tokenSuggestionItem,
                                    index === contextTokenSuggestions.length - 1 ? styles.tokenSuggestionItemLast : null,
                                ]}
                                onPress={() => applyContextSuggestion(token)}
                            >
                                <Text style={[styles.tokenSuggestionText, { color: tc.text }]}>{token}</Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                )}
                {frequentContextSuggestions.length > 0 && (
                    <View style={styles.quickTokensRow}>
                        {frequentContextSuggestions.map((token) => {
                            const isActive = selectedContextTokens.has(token);
                            return (
                                <TouchableOpacity
                                    key={token}
                                    style={getQuickTokenChipStyle(isActive)}
                                    onPress={() => toggleQuickContextToken(token)}
                                >
                                    <Text style={getQuickTokenTextStyle(isActive)}>{token}</Text>
                                </TouchableOpacity>
                            );
                        })}
                    </View>
                )}
            </View>
        );
    }

    return (
        <View style={styles.formGroup}>
            <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.tagsLabel')}</Text>
            <TextInput
                style={[styles.input, inputStyle]}
                value={tagInputDraft}
                onChangeText={updateTagInput}
                onFocus={(event) => {
                    setIsTagInputFocused(true);
                    handleInputFocus(event.nativeEvent.target);
                }}
                onBlur={commitTagDraft}
                onSubmitEditing={() => {
                    commitTagDraft();
                    Keyboard.dismiss();
                }}
                returnKeyType="done"
                blurOnSubmit
                placeholder={t('taskEdit.tagsPlaceholder')}
                autoCapitalize="none"
                placeholderTextColor={tc.secondaryText}
                accessibilityLabel={t('taskEdit.tagsLabel')}
                accessibilityHint={t('taskEdit.tagsPlaceholder')}
            />
            {tagTokenSuggestions.length > 0 && (
                <View style={[styles.tokenSuggestionsMenu, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                    {tagTokenSuggestions.map((token, index) => (
                        <TouchableOpacity
                            key={token}
                            style={[
                                styles.tokenSuggestionItem,
                                index === tagTokenSuggestions.length - 1 ? styles.tokenSuggestionItemLast : null,
                            ]}
                            onPress={() => applyTagSuggestion(token)}
                        >
                            <Text style={[styles.tokenSuggestionText, { color: tc.text }]}>{token}</Text>
                        </TouchableOpacity>
                    ))}
                </View>
            )}
            {frequentTagSuggestions.length > 0 && (
                <View style={styles.quickTokensRow}>
                    {frequentTagSuggestions.map((token) => {
                        const isActive = selectedTagTokens.has(token);
                        return (
                            <TouchableOpacity
                                key={token}
                                style={getQuickTokenChipStyle(isActive)}
                                onPress={() => toggleQuickTagToken(token)}
                            >
                                <Text style={getQuickTokenTextStyle(isActive)}>{token}</Text>
                            </TouchableOpacity>
                        );
                    })}
                </View>
            )}
        </View>
    );
}
