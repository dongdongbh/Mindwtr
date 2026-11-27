import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Check, ChevronDown, ChevronUp } from 'lucide-react-native';
import { getTaskTokenPickerOptions } from '@mindwtr/core';

import type { ThemeColors } from '@/hooks/use-theme-colors';

export function TokenPicker({ t, tc, label, tokens, selected, onToggle }: {
    t: (key: string) => string;
    tc: ThemeColors;
    label: string;
    tokens: readonly string[];
    selected: Iterable<string>;
    onToggle: (token: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const options = useMemo(() => open ? getTaskTokenPickerOptions(tokens, selected) : [], [open, selected, tokens]);
    const search = query.trim().toLowerCase();
    const visible = options.filter(({ token }) => token.toLowerCase().includes(search));
    const browseLabel = t('settings.browse');
    const searchLabel = t('common.search');
    const Chevron = open ? ChevronUp : ChevronDown;

    return (
        <View>
            <TouchableOpacity
                style={styles.trigger}
                accessibilityRole="button"
                accessibilityLabel={`${label} · ${browseLabel}`}
                accessibilityState={{ expanded: open }}
                onPress={() => {
                    setOpen(!open);
                    setQuery('');
                }}
            >
                <Text style={{ color: tc.tint }}>{browseLabel}</Text>
                <Chevron color={tc.tint} size={16} accessible={false} />
            </TouchableOpacity>
            {open && (
                <View style={[styles.panel, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                    <TextInput
                        style={[styles.search, { color: tc.text, backgroundColor: tc.inputBg, borderColor: tc.border }]}
                        accessibilityLabel={`${label} · ${searchLabel}`}
                        placeholder={searchLabel}
                        placeholderTextColor={tc.secondaryText}
                        autoCapitalize="none"
                        autoCorrect={false}
                        value={query}
                        onChangeText={setQuery}
                    />
                    <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled" style={styles.options}>
                        {visible.map((option) => (
                            <TouchableOpacity
                                key={option.token}
                                accessibilityRole="checkbox"
                                accessibilityLabel={option.token}
                                accessibilityState={{ checked: option.selected }}
                                style={[styles.option, { backgroundColor: option.selected ? tc.filterBg : tc.cardBg }]}
                                onPress={() => onToggle(option.token)}
                            >
                                <Text style={[styles.optionText, { color: tc.text }]}>{option.token}</Text>
                                {option.selected && <Check color={tc.tint} size={18} accessible={false} />}
                            </TouchableOpacity>
                        ))}
                        {visible.length === 0 && <Text accessibilityLiveRegion="polite" style={[styles.option, { color: tc.secondaryText }]}>{t('common.noMatches')}</Text>}
                    </ScrollView>
                </View>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    trigger: { minHeight: 44, flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6, paddingHorizontal: 8 },
    panel: { borderWidth: 1, borderRadius: 10, padding: 8, gap: 4 },
    search: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, minHeight: 44 },
    options: { maxHeight: 220 },
    option: { minHeight: 44, paddingHorizontal: 10, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 6 },
    optionText: { flex: 1 },
});
