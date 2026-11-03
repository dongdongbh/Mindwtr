import React, { useEffect, useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLanguage } from '../contexts/language-context';
import { useThemeColors } from '../hooks/use-theme-colors';
import { useAndroidKeyboardInset } from '../lib/use-android-keyboard-inset';

type TokenPickerModalProps = {
  visible: boolean;
  title: string;
  description?: string;
  tokens: string[];
  placeholder?: string;
  allowCustomValue?: boolean;

  multiSelect?: boolean;
  onConfirm: (values: string[]) => void;
  onClose: () => void;
};

export function TokenPickerModal({
  visible,
  title,
  description,
  tokens,
  placeholder,
  allowCustomValue = false,
  multiSelect = false,
  onConfirm,
  onClose,
}: TokenPickerModalProps) {
  const { t } = useLanguage();
  const tc = useThemeColors();
  const keyboardInset = useAndroidKeyboardInset(visible);
  const [query, setQuery] = useState('');
  const [selectedTokens, setSelectedTokens] = useState<string[]>([]);

  useEffect(() => {
    if (!visible) return;
    setQuery('');
    setSelectedTokens([]);
  }, [visible]);

  const filteredTokens = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return tokens;
    return tokens.filter((token) => token.toLowerCase().includes(normalizedQuery));
  }, [query, tokens]);

  const toggleToken = (token: string) => {
    if (multiSelect) {
      setSelectedTokens((current) => (current.includes(token)
        ? current.filter((item) => item !== token)
        : [...current, token]));
      return;
    }
    setSelectedTokens([token]);
    setQuery(token);
  };

  const confirmValues = multiSelect
    ? selectedTokens
    : [allowCustomValue ? (selectedTokens[0] ?? query.trim()) : (selectedTokens[0] ?? '')]
      .filter((value) => value.trim().length > 0);
  const canConfirm = confirmValues.length > 0;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable
        style={keyboardInset > 0 ? [styles.overlay, { paddingBottom: keyboardInset }] : styles.overlay}
        onPress={onClose}
      >
        <Pressable
          style={[styles.card, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
          onPress={(event) => event.stopPropagation()}
        >
          <Text style={[styles.title, { color: tc.text }]}>{title}</Text>
          {description ? (
            <Text style={[styles.description, { color: tc.secondaryText }]}>{description}</Text>
          ) : null}
          <TextInput
            autoFocus
            value={query}
            onChangeText={(value) => {
              setQuery(value);

              if (multiSelect) return;
              if (!allowCustomValue) {
                const exactMatch = tokens.find((token) => token.toLowerCase() === value.trim().toLowerCase());
                setSelectedTokens(exactMatch ? [exactMatch] : []);
              } else if (selectedTokens[0] && selectedTokens[0] !== value) {
                setSelectedTokens([]);
              }
            }}
            placeholder={placeholder}
            placeholderTextColor={tc.secondaryText}
            style={[
              styles.input,
              {
                backgroundColor: tc.inputBg,
                borderColor: tc.border,
                color: tc.text,
              },
            ]}
          />
          <ScrollView
            style={[styles.tokenList, { borderColor: tc.border, backgroundColor: tc.bg }]}
            contentContainerStyle={styles.tokenListContent}
          >
            {filteredTokens.length > 0 ? filteredTokens.map((token) => {
              const isActive = selectedTokens.includes(token);
              return (
                <TouchableOpacity
                  key={token}
                  onPress={() => toggleToken(token)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isActive }}
                  style={[
                    styles.tokenButton,
                    {
                      borderColor: isActive ? tc.tint : tc.border,
                      backgroundColor: isActive ? tc.tint : tc.filterBg,
                    },
                  ]}
                >
                  <Text style={[styles.tokenButtonText, { color: isActive ? tc.onTint : tc.text }]}>
                    {token}
                  </Text>
                </TouchableOpacity>
              );
            }) : (
              <View style={styles.emptyState}>
                <Text style={[styles.emptyText, { color: tc.secondaryText }]}>
                  {t('common.noMatches')}
                </Text>
              </View>
            )}
          </ScrollView>
          <View style={styles.buttonRow}>
            <TouchableOpacity onPress={onClose} style={styles.actionButton}>
              <Text style={[styles.actionButtonText, { color: tc.secondaryText }]}>{t('common.cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                if (canConfirm) {
                  onConfirm(confirmValues);
                }
              }}
              disabled={!canConfirm}
              style={[styles.actionButton, !canConfirm && styles.actionButtonDisabled]}
            >
              <Text style={[styles.actionButtonText, { color: tc.tint }]}>{t('common.save')}</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    justifyContent: 'center',
    padding: 20,
  },
  card: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 18,
    gap: 12,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
  },
  description: {
    fontSize: 13,
    lineHeight: 18,
  },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
  },
  tokenList: {
    maxHeight: 240,
    borderWidth: 1,
    borderRadius: 14,
  },
  tokenListContent: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    padding: 12,
  },
  tokenButton: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  tokenButtonText: {
    fontSize: 13,
    fontWeight: '600',
  },
  emptyState: {
    width: '100%',
    paddingVertical: 24,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 14,
  },
  buttonRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
  },
  actionButton: {
    paddingHorizontal: 4,
    paddingVertical: 6,
  },
  actionButtonDisabled: {
    opacity: 0.45,
  },
  actionButtonText: {
    fontSize: 15,
    fontWeight: '600',
  },
});
