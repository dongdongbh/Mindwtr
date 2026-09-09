import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { tFallback, type Area } from '@mindwtr/core';
import type { ThemeColors } from '@/hooks/use-theme-colors';
import { styles } from './task-edit-modal.styles';
import { logError } from '../../lib/app-log';
import { useAndroidKeyboardInset } from '../../lib/use-android-keyboard-inset';

type AreaPickerThemeColors = Pick<ThemeColors, 'border' | 'cardBg' | 'inputBg' | 'secondaryText' | 'text' | 'tint'> & {
    danger?: ThemeColors['danger'];
};

type AreaPickerLeadingOption = {
    key: string;
    label: string;
    accessibilityLabel?: string;
    selected?: boolean;
    disabled?: boolean;
    onPress: () => void;
};

interface TaskEditAreaPickerProps {
    visible: boolean;
    areas: Area[];
    tc: AreaPickerThemeColors;
    t: (key: string) => string;
    onClose: () => void;
    onSelectArea: (areaId?: string) => void;
    onCreateArea: (name: string) => Promise<Area | null>;
    allowCreate?: boolean;
    leadingOptions?: AreaPickerLeadingOption[];
    selectedAreaId?: string | null;
}

export function TaskEditAreaPicker({
    visible,
    areas = [],
    tc,
    t,
    onClose,
    onSelectArea,
    onCreateArea,
    allowCreate = true,
    leadingOptions = [],
    selectedAreaId,
}: TaskEditAreaPickerProps) {
    const [areaQuery, setAreaQuery] = useState('');
    const [createError, setCreateError] = useState<string | null>(null);
    const [isCreating, setIsCreating] = useState(false);
    const createAttemptRef = useRef(0);
    const creatingRef = useRef(false);
    const keyboardInset = useAndroidKeyboardInset(visible);

    useEffect(() => {
        createAttemptRef.current += 1;
        creatingRef.current = false;
        setIsCreating(false);
        setCreateError(null);
        if (visible) setAreaQuery('');
        return () => {
            createAttemptRef.current += 1;
            creatingRef.current = false;
        };
    }, [visible]);

    const activeAreas = useMemo(() => {
        return [...areas].sort((a, b) => a.name.localeCompare(b.name));
    }, [areas]);

    const normalizedAreaQuery = areaQuery.trim().toLowerCase();
    const filteredAreas = useMemo(() => {
        if (!normalizedAreaQuery) return activeAreas;
        return activeAreas.filter((area) =>
            area.name.toLowerCase().includes(normalizedAreaQuery)
        );
    }, [activeAreas, normalizedAreaQuery]);

    const hasExactAreaMatch = useMemo(() => {
        if (!normalizedAreaQuery) return false;
        return activeAreas.some((area) => area.name.toLowerCase() === normalizedAreaQuery);
    }, [activeAreas, normalizedAreaQuery]);

    const handleCreateArea = async () => {
        if (!allowCreate || creatingRef.current) return;
        const name = areaQuery.trim();
        if (!name) return;
        if (hasExactAreaMatch) {
            const matched = activeAreas.find((area) => area.name.toLowerCase() === normalizedAreaQuery);
            if (matched) {
                onSelectArea(matched.id);
            }
            onClose();
            return;
        }
        const attempt = ++createAttemptRef.current;
        creatingRef.current = true;
        setIsCreating(true);
        setCreateError(null);
        try {
            const created = await onCreateArea(name);
            if (attempt !== createAttemptRef.current) return;
            if (!created) {
                setCreateError(tFallback(t, 'projects.createAreaFailed', 'Failed to create area'));
                return;
            }
            onSelectArea(created.id);
            onClose();
        } catch (error) {
            if (attempt !== createAttemptRef.current) return;
            setCreateError(tFallback(t, 'projects.createAreaFailed', 'Failed to create area'));
            void logError(error, { scope: 'project', extra: { message: 'Failed to create area' } });
        } finally {
            if (attempt === createAttemptRef.current) {
                creatingRef.current = false;
                setIsCreating(false);
            }
        }
    };

    const closePicker = () => {
        if (creatingRef.current) return;
        createAttemptRef.current += 1;
        setCreateError(null);
        onClose();
    };

    return (
        <Modal
            visible={visible}
            transparent
            animationType="fade"
            onRequestClose={closePicker}
            accessibilityViewIsModal
        >
            <View style={keyboardInset > 0 ? [styles.overlay, { paddingBottom: keyboardInset }] : styles.overlay}>
                <View style={[styles.modalCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                    <Text style={[styles.modalTitle, { color: tc.text }]} accessibilityRole="header">
                        {t('taskEdit.areaLabel')}
                    </Text>
                    <TextInput
                        value={areaQuery}
                        onChangeText={(value) => {
                            setAreaQuery(value);
                            setCreateError(null);
                        }}
                        placeholder={t('common.search')}
                        placeholderTextColor={tc.secondaryText}
                        style={[styles.modalInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                        autoCapitalize="none"
                        autoCorrect={false}
                        returnKeyType="done"
                        blurOnSubmit
                        onSubmitEditing={handleCreateArea}
                        editable={!isCreating}
                        accessibilityLabel={t('taskEdit.areaLabel')}
                        accessibilityHint={t('common.search')}
                    />
                    {allowCreate && !hasExactAreaMatch && areaQuery.trim() && (
                        <Pressable
                            onPress={handleCreateArea}
                            disabled={isCreating}
                            style={styles.pickerItem}
                            accessibilityRole="button"
                            accessibilityLabel={`${t('areas.create')}: ${areaQuery.trim()}`}
                            accessibilityState={{ disabled: isCreating, busy: isCreating }}
                        >
                            {isCreating ? (
                                <ActivityIndicator size="small" color={tc.tint} />
                            ) : (
                                <Text
                                    style={[styles.pickerItemText, { color: tc.tint }]}
                                >
                                    + {t('areas.create')} &quot;{areaQuery.trim()}&quot;
                                </Text>
                            )}
                        </Pressable>
                    )}
                    {createError ? (
                        <View style={styles.pickerItem}>
                            <Text
                                testID="area-create-error"
                                style={[styles.pickerItemText, { color: tc.danger ?? tc.secondaryText }]}
                                accessibilityRole="alert"
                                accessibilityLiveRegion="assertive"
                            >
                                {createError}
                            </Text>
                        </View>
                    ) : null}
                    <ScrollView
                        style={[styles.pickerList, { borderColor: tc.border, backgroundColor: tc.inputBg }]}
                        contentContainerStyle={{ paddingVertical: 4 }}
                    >
                        {leadingOptions.map((option) => (
                            <Pressable
                                key={option.key}
                                onPress={() => {
                                    option.onPress();
                                    closePicker();
                                }}
                                disabled={option.disabled || isCreating}
                                style={styles.pickerItem}
                                accessibilityRole="button"
                                accessibilityLabel={option.accessibilityLabel ?? option.label}
                                accessibilityState={{ selected: Boolean(option.selected), disabled: Boolean(option.disabled) || isCreating }}
                            >
                                <Text style={[styles.pickerItemText, { color: option.disabled ? tc.secondaryText : tc.text }]}>{option.label}</Text>
                            </Pressable>
                        ))}
                        <Pressable
                            onPress={() => {
                                onSelectArea(undefined);
                                closePicker();
                            }}
                            disabled={isCreating}
                            style={styles.pickerItem}
                            accessibilityRole="button"
                            accessibilityLabel={t('taskEdit.noAreaOption')}
                            accessibilityState={{ selected: selectedAreaId === null, disabled: isCreating }}
                        >
                            <Text style={[styles.pickerItemText, { color: tc.text }]}>{t('taskEdit.noAreaOption')}</Text>
                        </Pressable>
                        {filteredAreas.map((area) => (
                            <Pressable
                                key={area.id}
                                onPress={() => {
                                    onSelectArea(area.id);
                                    closePicker();
                                }}
                                disabled={isCreating}
                                style={styles.pickerItem}
                                accessibilityRole="button"
                                accessibilityLabel={area.name}
                                accessibilityState={{ selected: selectedAreaId === area.id, disabled: isCreating }}
                            >
                                <Text style={[styles.pickerItemText, { color: tc.text }]}>{area.name}</Text>
                            </Pressable>
                        ))}
                        {filteredAreas.length === 0 && (
                            <View style={styles.pickerItem}>
                                <Text
                                    style={[styles.pickerItemText, { color: tc.secondaryText }]}
                                    accessibilityRole="text"
                                    accessibilityLiveRegion="polite"
                                >
                                    {t('common.noMatches')}
                                </Text>
                            </View>
                        )}
                    </ScrollView>
                    <View style={styles.modalButtons}>
                        <TouchableOpacity
                            onPress={closePicker}
                            disabled={isCreating}
                            style={styles.modalButton}
                            accessibilityRole="button"
                            accessibilityLabel={t('common.cancel')}
                            accessibilityState={{ disabled: isCreating }}
                        >
                            <Text style={[styles.modalButtonText, { color: tc.secondaryText }]}>{t('common.cancel')}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </View>
        </Modal>
    );
}
