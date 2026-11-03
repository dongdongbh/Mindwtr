import React from 'react';
import { Modal, Platform, Pressable, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Ban } from 'lucide-react-native';
import { areaOrderIdsForIntent, sortAreasForOrderDisplay, isManageAreaNameTaken, flushPendingSave, runStoreCommand, useTaskStore, tFallback, type Area, type Project } from '@mindwtr/core';

import { projectsScreenStyles as styles } from './projects-screen.styles';
import { getLiveMutableProject } from './project-meta-pickers';
import { logInfo } from '../../lib/app-log';
import { useAndroidKeyboardInset } from '../../lib/use-android-keyboard-inset';

type ThemeColors = {
    border: string;
    cardBg: string;
    inputBg: string;
    secondaryText: string;
    text: string;
    tint: string;
};

type ProjectAreaModalsProps = {
    managerAreaId?: string | null;
    addArea: (name: string, options: { color: string }) => void | Promise<unknown>;
    areaListMaxHeight: number;
    areaManagerListMaxHeight: number;
    areaUsage: Map<string, number>;
    colors: readonly string[];
    expandedAreaColorId: string | null;
    newAreaColor: string;
    newAreaName: string;
    onCloseAreaManager: () => void;
    onDeleteArea: (id: string) => unknown;
    onSetExpandedAreaColorId: React.Dispatch<React.SetStateAction<string | null>>;
    onSetNewAreaColor: React.Dispatch<React.SetStateAction<string>>;
    onSetNewAreaName: React.Dispatch<React.SetStateAction<string>>;
    onSetSelectedProject: React.Dispatch<React.SetStateAction<Project | null>>;
    onSetShowAreaManager: React.Dispatch<React.SetStateAction<boolean>>;
    onSetShowAreaPicker: React.Dispatch<React.SetStateAction<boolean>>;
    reorderAreas: (orderedIds: string[]) => void | Promise<void>;
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
    updateProject: (id: string, updates: Partial<Project>) => unknown;
};

export function ProjectAreaModals({
    managerAreaId = null,
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
    reorderAreas,
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
    const keyboardInset = useAndroidKeyboardInset(showAreaManager);
    const [editingAreaId, setEditingAreaId] = React.useState<string | null>(null);
    const [areaName, setAreaName] = React.useState('');
    const [saving, setSaving] = React.useState(false);
    const savingRef = React.useRef(false);
    const pendingManager = React.useRef(false);
    const newAreaNameTaken = isManageAreaNameTaken('newArea', newAreaName, sortedAreas);
    const areaNameTaken = isManageAreaNameTaken('newArea', areaName, sortedAreas.filter((area) => area.id !== editingAreaId));
    React.useEffect(() => {
        if (!showAreaManager) return;
        const area = sortedAreas.find((area) => area.id === managerAreaId);
        setEditingAreaId(area?.id ?? null);
        setAreaName(area?.name ?? '');

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showAreaManager, managerAreaId]);
    const dismissProjectPickers = React.useCallback(() => {
        onSetShowAreaPicker(false);
        onSetShowAreaManager(false);
    }, [onSetShowAreaManager, onSetShowAreaPicker]);
    const saveChange = async (work: () => Promise<void>, failureLabel = 'common.error') => {
        if (savingRef.current) return;
        savingRef.current = true;
        setSaving(true);
        try {
            await runStoreCommand(work);
        } catch {
            onShowToast({ title: t('common.error'), message: t(failureLabel), tone: 'error' });
        } finally {
            savingRef.current = false;
            setSaving(false);
        }
    };
    const checkOutcome = (result: unknown) => {
        if (result && typeof result === 'object' && 'success' in result && result.success === false) {
            throw new Error('Write rejected');
        }
    };
    const setProjectArea = (areaId?: string) => saveChange(async () => {
        const project = selectedProject && getLiveMutableProject(selectedProject.id);
        if (!project) {
            dismissProjectPickers();
            return;
        }
        if (areaId && !useTaskStore.getState().areas.some((area) => area.id === areaId && !area.deletedAt)) {
            throw new Error('Area no longer exists');
        }
        checkOutcome(await updateProject(project.id, { areaId }));
        await flushPendingSave();
        onSetSelectedProject({ ...project, areaId });
        onSetShowAreaPicker(false);
        void logInfo('Project management shortcut saved', {
            scope: 'projects', force: true,
            extra: { releaseCheck: 'v1.3.8/projects-management-shortcuts', outcome: 'moved' },
        });
    }, 'projects.moveProjectFailed');
    const renameArea = () => saveChange(async () => {
        const name = areaName.trim();
        const liveAreas = useTaskStore.getState().areas.filter((area) => !area.deletedAt);
        const area = liveAreas.find((area) => area.id === editingAreaId);
        if (!area || !name) throw new Error('Area no longer exists');
        if (isManageAreaNameTaken('newArea', name, liveAreas.filter((other) => other.id !== area.id))) {
            onShowToast({ title: t('common.notice'), message: tFallback(t, 'areas.nameExists', 'An area with this name already exists.'), tone: 'warning' });
            return;
        }
        checkOutcome(await updateArea(area.id, { name }));
        await flushPendingSave();
        setEditingAreaId(null);
        void logInfo('Project management shortcut saved', {
            scope: 'projects', force: true,
            extra: { releaseCheck: 'v1.3.8/projects-management-shortcuts', outcome: 'renamed' },
        });
    });
    const openManagerFromPicker = () => {
        if (!selectedProject || !getLiveMutableProject(selectedProject.id)) {
            dismissProjectPickers();
            return;
        }
        onSetNewAreaName('');
        onSetNewAreaColor(colors[0] || '#3b82f6');
        pendingManager.current = Platform.OS === 'ios';
        onSetShowAreaPicker(false);
        if (Platform.OS !== 'ios') onSetShowAreaManager(true);
    };
    React.useEffect(() => {
        if (selectedProject?.status !== 'archived') return;
        dismissProjectPickers();
    }, [dismissProjectPickers, selectedProject?.status]);

    return (
        <>
            <Modal
                visible={showAreaPicker}
                transparent
                animationType="fade"
                presentationStyle={overlayModalPresentation}
                onDismiss={() => {
                    if (!pendingManager.current) return;
                    pendingManager.current = false;
                    onSetShowAreaManager(true);
                }}
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
                            accessibilityRole="button"
                            accessibilityLabel={t('projects.manageAreas')}
                            onPress={openManagerFromPicker}
                        >
                            <Text style={[styles.pickerRowText, { color: tc.secondaryText }]}>{t('projects.manageAreas')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[styles.pickerRow, { borderColor: tc.border }]}
                            disabled={saving}
                            onPress={() => { void setProjectArea(undefined); }}
                        >
                            <Text style={[styles.pickerRowText, { color: tc.text }]}>{t('projects.noArea')}</Text>
                        </TouchableOpacity>
                        <ScrollView style={{ maxHeight: areaListMaxHeight }}>
                            {sortedAreas.map((area) => (
                                <TouchableOpacity
                                    key={area.id}
                                    testID={`project-area-picker-${area.id}`}
                                    accessibilityRole="button"
                                    accessibilityLabel={area.name}
                                    style={[styles.pickerRow, { borderColor: tc.border }]}
                                    disabled={saving}
                                    onPress={() => { void setProjectArea(area.id); }}
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
                <Pressable
                    style={keyboardInset > 0 ? [styles.overlay, { paddingBottom: keyboardInset }] : styles.overlay}
                    onPress={onCloseAreaManager}
                >
                    <Pressable
                        style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border, maxHeight: pickerCardMaxHeight }]}
                        onPress={(event) => event.stopPropagation()}
                    >
                        <View style={styles.areaManagerHeader}>
                            <Text style={[styles.linkModalTitle, { color: tc.text }]}>{t('projects.manageAreas')}</Text>
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
                                {sortedAreas.map((area, index) => {
                                    if (managerAreaId && area.id !== managerAreaId) return null;
                                    const inUse = (areaUsage.get(area.id) || 0) > 0;
                                    const isExpanded = expandedAreaColorId === area.id;
                                    return (
                                        <View key={area.id} style={styles.areaManagerItem}>
                                            <View style={[styles.areaManagerRow, { borderColor: tc.border }, managerAreaId && { flexDirection: 'column', alignItems: 'stretch' }]}>
                                                <TouchableOpacity
                                                    accessibilityRole="button"
                                                    accessibilityLabel={`${t('projects.renameArea')}: ${area.name}`}
                                                    onPress={() => { setEditingAreaId(area.id); setAreaName(area.name); }}
                                                    style={styles.areaManagerInfo}
                                                >
                                                    <View style={[styles.areaDot, { backgroundColor: area.color || tc.tint }]} />
                                                    <Text numberOfLines={1} style={[styles.areaManagerText, { color: tc.text }]}>{area.name}</Text>
                                                </TouchableOpacity>
                                                <View style={[styles.areaManagerActions, managerAreaId && { flexWrap: 'wrap' }]}>
                                                    <TouchableOpacity
                                                        accessibilityRole="button"
                                                        accessibilityLabel={`${t('projects.moveUp')}: ${area.name}`}
                                                        accessibilityState={{ disabled: index === 0 }}
                                                        disabled={index === 0}
                                                        onPress={() => {
                                                            void saveChange(async () => {
                                                                const ids = areaOrderIdsForIntent(sortAreasForOrderDisplay(useTaskStore.getState().areas), { kind: 'moveUp', areaId: area.id });
                                                                if (ids) { await reorderAreas(ids); await flushPendingSave(); }
                                                            }, 'projects.areaReorderFailed');
                                                        }}
                                                        style={[styles.areaOrderButton, index === 0 && styles.areaOrderButtonDisabled]}
                                                    >
                                                        <Text style={[styles.areaOrderText, { color: tc.text }]}>↑</Text>
                                                    </TouchableOpacity>
                                                    {managerAreaId ? <TouchableOpacity
                                                        accessibilityRole="button"
                                                        accessibilityLabel={`${t('projects.moveDown')}: ${area.name}`}
                                                        disabled={index === sortedAreas.length - 1 || saving}
                                                        style={[styles.areaOrderButton, index === sortedAreas.length - 1 && styles.areaOrderButtonDisabled]}
                                                        onPress={() => { void saveChange(async () => {
                                                            const live = sortAreasForOrderDisplay(useTaskStore.getState().areas);
                                                            const next = live[live.findIndex((entry) => entry.id === area.id) + 1];
                                                            if (!live.some((entry) => entry.id === area.id) || !next) return;
                                                            const ids = areaOrderIdsForIntent(live, { kind: 'moveUp', areaId: next.id });
                                                            if (ids) { await reorderAreas(ids); await flushPendingSave(); }
                                                        }, 'projects.areaReorderFailed'); }}
                                                    >
                                                        <Text style={[styles.areaOrderText, { color: tc.text }]}>↓</Text>
                                                    </TouchableOpacity> : null}
                                                    <TouchableOpacity
                                                        accessibilityRole="button"
                                                        accessibilityLabel={`${t('projects.changeColor')}: ${area.name}`}
                                                        onPress={() => onSetExpandedAreaColorId(isExpanded ? null : area.id)}
                                                        style={[styles.colorToggleButton, { borderColor: tc.border }]}
                                                    >
                                                        <View style={[styles.colorOption, { backgroundColor: area.color || tc.tint }]} />
                                                    </TouchableOpacity>
                                                    <TouchableOpacity
                                                        disabled={inUse}
                                                        accessibilityRole="button"
                                                        accessibilityLabel={`${t('common.delete')}: ${area.name}`}
                                                        onPress={() => { void saveChange(async () => {
                                                            const live = useTaskStore.getState();
                                                            if (live.projects.some((project) => !project.deletedAt && project.areaId === area.id)) {
                                                                onShowToast({ title: t('common.notice'), message: tFallback(t, 'projects.areaInUse', 'Area has projects.'), tone: 'warning' });
                                                                return;
                                                            }
                                                            if (!live.areas.some((entry) => entry.id === area.id && !entry.deletedAt)) return;
                                                            checkOutcome(await onDeleteArea(area.id));
                                                            await flushPendingSave();
                                                        }); }}
                                                        style={[styles.areaDeleteButton, inUse && styles.areaDeleteButtonDisabled]}
                                                    >
                                                        <Text style={[styles.areaDeleteText, { color: inUse ? tc.secondaryText : '#EF4444' }]}>
                                                            {t('common.delete')}
                                                        </Text>
                                                    </TouchableOpacity>
                                                </View>
                                            </View>
                                            {editingAreaId === area.id ? (
                                                <View>
                                                    <TextInput
                                                        accessibilityLabel={t('projects.renameArea')}
                                                        value={areaName}
                                                        onChangeText={setAreaName}
                                                        style={[styles.linkModalInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                                                    />
                                                    {areaNameTaken ? <Text style={[styles.linkModalHint, { color: '#EF4444' }]}>{tFallback(t, 'areas.nameExists', 'An area with this name already exists.')}</Text> : null}
                                                    <View style={styles.linkModalButtons}>
                                                        <TouchableOpacity style={styles.linkModalButton} onPress={() => setEditingAreaId(null)}>
                                                            <Text style={[styles.linkModalButtonText, { color: tc.secondaryText }]}>{t('common.cancel')}</Text>
                                                        </TouchableOpacity>
                                                        <TouchableOpacity
                                                            testID="area-rename-save"
                                                            accessibilityRole="button"
                                                            accessibilityLabel={t('common.rename')}
                                                            disabled={saving || !areaName.trim() || areaNameTaken}
                                                            style={[styles.linkModalButton, (saving || !areaName.trim() || areaNameTaken) && styles.linkModalButtonDisabled]}
                                                            onPress={() => { if (areaName.trim() && !areaNameTaken) void renameArea(); }}
                                                        >
                                                            <Text style={[styles.linkModalButtonText, { color: tc.tint }]}>{t('common.save')}</Text>
                                                        </TouchableOpacity>
                                                    </View>
                                                </View>
                                            ) : null}
                                            {isExpanded ? (
                                                <View style={styles.areaColorPickerRow}>
                                                    <TouchableOpacity
                                                        accessibilityLabel={tFallback(t, 'projects.colorNone', 'None')}
                                                        style={[
                                                            styles.colorOption,
                                                            styles.colorOptionNone,
                                                            { borderColor: tc.border },


                                                            !area.color && { borderColor: tc.tint },
                                                        ]}
                                                        onPress={() => {
                                                            void saveChange(async () => {
                                                                checkOutcome(await updateArea(area.id, { color: undefined }));
                                                                await flushPendingSave();
                                                                onSetExpandedAreaColorId(null);
                                                            }, 'projects.colorSaveFailed');
                                                        }}
                                                    >
                                                        <Ban size={16} color={tc.secondaryText} />
                                                    </TouchableOpacity>
                                                    {colors.map((color) => (
                                                        <TouchableOpacity
                                                            key={`${area.id}-${color}`}
                                                            style={[
                                                                styles.colorOption,
                                                                { backgroundColor: color },
                                                                (area.color || tc.tint) === color && styles.colorOptionSelected,
                                                            ]}
                                                            onPress={() => {
                                                                void saveChange(async () => {
                                                                    checkOutcome(await updateArea(area.id, { color }));
                                                                    await flushPendingSave();
                                                                    onSetExpandedAreaColorId(null);
                                                                }, 'projects.colorSaveFailed');
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
                        {managerAreaId ? (
                            <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('areas.new')} style={styles.linkModalButton} onPress={() => {
                                onCloseAreaManager();
                                onSetNewAreaName('');
                                onSetNewAreaColor(colors[0] || '#3b82f6');

                                onSetShowAreaManager(true);
                            }}>
                                <Text style={[styles.linkModalButtonText, { color: tc.tint }]}>{t('areas.new')}</Text>
                            </TouchableOpacity>
                        ) : null}
                        {!managerAreaId ? <>
                        <Text style={[styles.helperText, { color: tc.secondaryText }]}>{t('areas.new')}</Text>
                        <TextInput
                            value={newAreaName}
                            onChangeText={onSetNewAreaName}
                            placeholder={t('projects.areaLabel')}
                            placeholderTextColor={tc.secondaryText}
                            style={[styles.linkModalInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                        />
                        {newAreaNameTaken ? (
                            <Text style={[styles.linkModalHint, { color: '#EF4444' }]}>
                                {tFallback(t, 'areas.nameExists', 'An area with this name already exists.')}
                            </Text>
                        ) : null}
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
                                accessibilityRole="button"
                                accessibilityLabel={t('common.save')}
                                onPress={() => { if (newAreaNameTaken) return; void saveChange(async () => {
                                    const name = newAreaName.trim();
                                    const liveAreas = useTaskStore.getState().areas.filter((area) => !area.deletedAt);
                                    if (!name || isManageAreaNameTaken('newArea', name, liveAreas)) return;
                                    const created = await addArea(name, { color: newAreaColor });
                                    if (created === null) throw new Error('Area creation failed');
                                    await flushPendingSave();
                                    onCloseAreaManager();
                                    onSetNewAreaName('');
                                }, 'projects.createAreaFailed'); }}
                                disabled={saving || !newAreaName.trim() || newAreaNameTaken}
                                style={[styles.linkModalButton, (saving || !newAreaName.trim() || newAreaNameTaken) && styles.linkModalButtonDisabled]}
                            >
                                <Text style={[styles.linkModalButtonText, { color: tc.tint }]}>{t('common.save')}</Text>
                            </TouchableOpacity>
                        </View>
                        </> : null}
                    </Pressable>
                </Pressable>
            </Modal>
        </>
    );
}
