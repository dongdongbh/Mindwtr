import React from 'react';
import { Modal, Pressable, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import type { Area, Project } from '@mindwtr/core';

import { projectsScreenStyles as styles } from './projects-screen.styles';

type ThemeColors = {
    border: string;
    cardBg: string;
    inputBg: string;
    secondaryText: string;
    text: string;
    tint: string;
};

type ProjectAreaModalsProps = {
    addArea: (name: string, options: { color: string }) => void | Promise<unknown>;
    areaListMaxHeight: number;
    areaManagerListMaxHeight: number;
    areaUsage: Map<string, number>;
    colors: readonly string[];
    expandedAreaColorId: string | null;
    newAreaColor: string;
    newAreaName: string;
    onCloseAreaManager: () => void;
    onDeleteArea: (id: string) => void;
    onSetExpandedAreaColorId: React.Dispatch<React.SetStateAction<string | null>>;
    onSetNewAreaColor: React.Dispatch<React.SetStateAction<string>>;
    onSetNewAreaName: React.Dispatch<React.SetStateAction<string>>;
    onSetSelectedProject: React.Dispatch<React.SetStateAction<Project | null>>;
    onSetShowAreaManager: React.Dispatch<React.SetStateAction<boolean>>;
    onSetShowAreaPicker: React.Dispatch<React.SetStateAction<boolean>>;
    onShowToast: (options: { title: string; message: string; tone: 'warning' | 'error' | 'success' | 'info' }) => void;
    overlayModalPresentation: 'overFullScreen' | 'fullScreen';
    pickerCardMaxHeight: number;
    selectedProject: Project | null;
    showAreaManager: boolean;
    showAreaPicker: boolean;
    sortedAreas: Area[];
    sortAreasByColor: () => void;
    sortAreasByName: () => void;
    t: (key: string) => string;
    tc: ThemeColors;
    updateArea: (id: string, updates: Partial<Area>) => void | Promise<unknown>;
    updateProject: (id: string, updates: Partial<Project>) => void;
};

export function ProjectAreaModals({
    addArea,
    areaListMaxHeight,
    areaManagerListMaxHeight,
    areaUsage,
    colors,
    expandedAreaColorId,
    newAreaColor,
    newAreaName,
    onCloseAreaManager,
    onDeleteArea,
    onSetExpandedAreaColorId,
    onSetNewAreaColor,
    onSetNewAreaName,
    onSetSelectedProject,
    onSetShowAreaManager,
    onSetShowAreaPicker,
    onShowToast,
    overlayModalPresentation,
    pickerCardMaxHeight,
    selectedProject,
    showAreaManager,
    showAreaPicker,
    sortedAreas,
    sortAreasByColor,
    sortAreasByName,
    t,
    tc,
    updateArea,
    updateProject,
}: ProjectAreaModalsProps) {
    return (
        <>
            <Modal
                visible={showAreaPicker}
                transparent
                animationType="fade"
                presentationStyle={overlayModalPresentation}
                onRequestClose={() => onSetShowAreaPicker(false)}
            >
                <Pressable style={styles.overlay} onPress={() => onSetShowAreaPicker(false)}>
                    <Pressable
                        style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border, maxHeight: pickerCardMaxHeight }]}
                        onPress={(event) => event.stopPropagation()}
                    >
                        <Text style={[styles.linkModalTitle, { color: tc.text }]}>{t('projects.areaLabel')}</Text>
                        <TouchableOpacity
                            style={[styles.pickerRow, { borderColor: tc.border }]}
                            onPress={() => {
                                onSetShowAreaPicker(false);
                                onSetNewAreaName('');
                                onSetNewAreaColor(colors[0] || '#3b82f6');
                                onSetShowAreaManager(true);
                            }}
                        >
                            <Text style={[styles.pickerRowText, { color: tc.secondaryText }]}>+ {t('projects.areaLabel')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[styles.pickerRow, { borderColor: tc.border }]}
                            onPress={() => {
                                if (!selectedProject) return;
                                updateProject(selectedProject.id, { areaId: undefined });
                                onSetSelectedProject({ ...selectedProject, areaId: undefined });
                                onSetShowAreaPicker(false);
                            }}
                        >
                            <Text style={[styles.pickerRowText, { color: tc.text }]}>{t('projects.noArea')}</Text>
                        </TouchableOpacity>
                        <ScrollView style={{ maxHeight: areaListMaxHeight }}>
                            {sortedAreas.map((area) => (
                                <TouchableOpacity
                                    key={area.id}
                                    style={[styles.pickerRow, { borderColor: tc.border }]}
                                    onPress={() => {
                                        if (!selectedProject) return;
                                        updateProject(selectedProject.id, { areaId: area.id });
                                        onSetSelectedProject({ ...selectedProject, areaId: area.id });
                                        onSetShowAreaPicker(false);
                                    }}
                                >
                                    <View style={[styles.areaDot, { backgroundColor: area.color || tc.tint }]} />
                                    <Text style={[styles.pickerRowText, { color: tc.text }]}>{area.name}</Text>
                                </TouchableOpacity>
                            ))}
                        </ScrollView>
                    </Pressable>
                </Pressable>
            </Modal>

            <Modal
                visible={showAreaManager}
                transparent
                animationType="fade"
                presentationStyle={overlayModalPresentation}
                onRequestClose={onCloseAreaManager}
            >
                <Pressable style={styles.overlay} onPress={onCloseAreaManager}>
                    <Pressable
                        style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border, maxHeight: pickerCardMaxHeight }]}
                        onPress={(event) => event.stopPropagation()}
                    >
                        <View style={styles.areaManagerHeader}>
                            <Text style={[styles.linkModalTitle, { color: tc.text }]}>{t('projects.areaLabel')}</Text>
                            <View style={styles.areaSortButtons}>
                                <TouchableOpacity onPress={sortAreasByName} style={[styles.areaSortButton, { borderColor: tc.border }]}>
                                    <Text style={[styles.areaSortText, { color: tc.secondaryText }]}>{t('projects.sortByName')}</Text>
                                </TouchableOpacity>
                                <TouchableOpacity onPress={sortAreasByColor} style={[styles.areaSortButton, { borderColor: tc.border }]}>
                                    <Text style={[styles.areaSortText, { color: tc.secondaryText }]}>{t('projects.sortByColor')}</Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                        {sortedAreas.length === 0 ? (
                            <Text style={[styles.helperText, { color: tc.secondaryText }]}>{t('projects.noArea')}</Text>
                        ) : (
                            <ScrollView
                                style={{ maxHeight: areaManagerListMaxHeight, minHeight: 120 }}
                                contentContainerStyle={[styles.areaManagerList, { flexGrow: 1 }]}
                                showsVerticalScrollIndicator
                                nestedScrollEnabled
                            >
                                {sortedAreas.map((area) => {
                                    const inUse = (areaUsage.get(area.id) || 0) > 0;
                                    const isExpanded = expandedAreaColorId === area.id;
                                    return (
                                        <View key={area.id} style={styles.areaManagerItem}>
                                            <View style={[styles.areaManagerRow, { borderColor: tc.border }]}>
                                                <View style={styles.areaManagerInfo}>
                                                    <View style={[styles.areaDot, { backgroundColor: area.color || tc.tint }]} />
                                                    <Text style={[styles.areaManagerText, { color: tc.text }]}>{area.name}</Text>
                                                </View>
                                                <View style={styles.areaManagerActions}>
                                                    <TouchableOpacity
                                                        onPress={() => onSetExpandedAreaColorId(isExpanded ? null : area.id)}
                                                        style={[styles.colorToggleButton, { borderColor: tc.border }]}
                                                    >
                                                        <View style={[styles.colorOption, { backgroundColor: area.color || tc.tint }]} />
                                                    </TouchableOpacity>
                                                    <TouchableOpacity
                                                        disabled={inUse}
                                                        onPress={() => {
                                                            if (inUse) {
                                                                onShowToast({
                                                                    title: t('common.notice') || 'Notice',
                                                                    message: t('projects.areaInUse') || 'Area has projects.',
                                                                    tone: 'warning',
                                                                });
                                                                return;
                                                            }
                                                            onDeleteArea(area.id);
                                                        }}
                                                        style={[styles.areaDeleteButton, inUse && styles.areaDeleteButtonDisabled]}
                                                    >
                                                        <Text style={[styles.areaDeleteText, { color: inUse ? tc.secondaryText : '#EF4444' }]}>
                                                            {t('common.delete')}
                                                        </Text>
                                                    </TouchableOpacity>
                                                </View>
                                            </View>
                                            {isExpanded ? (
                                                <View style={styles.areaColorPickerRow}>
                                                    {colors.map((color) => (
                                                        <TouchableOpacity
                                                            key={`${area.id}-${color}`}
                                                            style={[
                                                                styles.colorOption,
                                                                { backgroundColor: color },
                                                                (area.color || tc.tint) === color && styles.colorOptionSelected,
                                                            ]}
                                                            onPress={() => {
                                                                void updateArea(area.id, { color });
                                                                onSetExpandedAreaColorId(null);
                                                            }}
                                                        />
                                                    ))}
                                                </View>
                                            ) : null}
                                        </View>
                                    );
                                })}
                            </ScrollView>
                        )}
                        <TextInput
                            value={newAreaName}
                            onChangeText={onSetNewAreaName}
                            placeholder={t('projects.areaLabel')}
                            placeholderTextColor={tc.secondaryText}
                            style={[styles.linkModalInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                        />
                        <View style={styles.colorPicker}>
                            {colors.map((color) => (
                                <TouchableOpacity
                                    key={color}
                                    style={[
                                        styles.colorOption,
                                        { backgroundColor: color },
                                        newAreaColor === color && styles.colorOptionSelected,
                                    ]}
                                    onPress={() => onSetNewAreaColor(color)}
                                />
                            ))}
                        </View>
                        <View style={styles.linkModalButtons}>
                            <TouchableOpacity onPress={onCloseAreaManager} style={styles.linkModalButton}>
                                <Text style={[styles.linkModalButtonText, { color: tc.secondaryText }]}>{t('common.cancel')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                onPress={() => {
                                    const name = newAreaName.trim();
                                    if (!name) return;
                                    void addArea(name, { color: newAreaColor });
                                    onCloseAreaManager();
                                    onSetNewAreaName('');
                                }}
                                disabled={!newAreaName.trim()}
                                style={[styles.linkModalButton, !newAreaName.trim() && styles.linkModalButtonDisabled]}
                            >
                                <Text style={[styles.linkModalButtonText, { color: tc.tint }]}>{t('common.save')}</Text>
                            </TouchableOpacity>
                        </View>
                    </Pressable>
                </Pressable>
            </Modal>
        </>
    );
}
