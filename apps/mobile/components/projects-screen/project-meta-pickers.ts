import { Area, Project, translateWithFallback, type TranslateFn, tFallback, useTaskStore } from '@mindwtr/core';
import { ActionSheetIOS, Alert, Keyboard, Platform } from 'react-native';

import type { ToastOptions } from '@/contexts/toast-context';
import { normalizeProjectTag } from '@/components/projects-screen/projects-screen.utils';

type AreaColorMeta = {
    nameKey: string;
    swatch: string;
};

type ProjectLookup = (projectId: string) => Project | undefined;

const readLiveProject: ProjectLookup = (projectId) => (
    useTaskStore.getState()._allProjects?.find((project) => project.id === projectId)
);

export const getLiveMutableProject = (
    projectId: string,
    getProjectById: ProjectLookup = readLiveProject,
): Project | null => {
    const project = getProjectById(projectId);
    if (!project || project.deletedAt || project.status === 'archived') return null;
    return project;
};

export const applyLiveProjectUpdate = ({
    getProjectById = readLiveProject,
    onBlocked,
    projectId,
    setSelectedProject,
    updateProject,
    updates,
}: {
    getProjectById?: ProjectLookup;
    onBlocked?: () => void;
    projectId: string;
    setSelectedProject: (project: Project | null) => void;
    updateProject: (id: string, updates: Partial<Project>) => unknown;
    updates: Partial<Project> | ((project: Project) => Partial<Project> | null);
}): boolean => {
    const project = getLiveMutableProject(projectId, getProjectById);
    if (!project) {
        onBlocked?.();
        return false;
    }
    const patch = typeof updates === 'function' ? updates(project) : updates;
    if (!patch) return false;
    updateProject(project.id, patch);
    setSelectedProject({ ...project, ...patch });
    return true;
};

/**
 * Spoken/printed labels for the area swatches, used by the iOS action sheets
 * (which list colors as text rows, not dots). Keyed by the exact hex in
 * AREA_PRESET_COLORS — a preset missing here falls back to its raw hex, so
 * every new swatch needs a row.
 */
export const AREA_COLOR_DISPLAY_BY_HEX: Record<string, AreaColorMeta> = {
    '#3b82f6': { nameKey: 'projects.colorBlue', swatch: '🔵' },
    '#10b981': { nameKey: 'projects.colorGreen', swatch: '🟢' },
    '#f59e0b': { nameKey: 'projects.colorAmber', swatch: '🟠' },
    '#ef4444': { nameKey: 'projects.colorRed', swatch: '🔴' },
    '#8b5cf6': { nameKey: 'projects.colorPurple', swatch: '🟣' },
    '#ec4899': { nameKey: 'projects.colorPink', swatch: '🩷' },
    '#f97316': { nameKey: 'projects.colorOrange', swatch: '🟠' },
    '#14b8a6': { nameKey: 'projects.colorTeal', swatch: '🩵' },
    '#06b6d4': { nameKey: 'projects.colorCyan', swatch: '🩵' },
    '#6366f1': { nameKey: 'projects.colorIndigo', swatch: '🔵' },
    '#f43f5e': { nameKey: 'projects.colorRose', swatch: '🔴' },
    '#64748b': { nameKey: 'projects.colorSlate', swatch: '🩶' },
};

const areaColorLabel = (t: TranslateFn, color: string): string => {
    const meta = AREA_COLOR_DISPLAY_BY_HEX[color] ?? { nameKey: '', swatch: '◯' };
    const name = meta.nameKey ? t(meta.nameKey) : color.toUpperCase();
    return `${meta.swatch} ${name}`;
};

type OpenProjectAreaPickerArgs = {
    addArea: (name: string, options: { color: string }) => Promise<Area | null | undefined>;
    areaUsage: Map<string, number>;
    colors: readonly string[];
    deleteArea: (id: string) => void;
    logProjectError: (message: string, error?: unknown) => void;
    selectedProject: Project | null;
    setSelectedProject: (project: Project | null) => void;
    setShowAreaPicker: (visible: boolean) => void;
    showToast: (toast: ToastOptions) => void;
    sortAreasByColor: () => void;
    sortAreasByName: () => void;
    sortedAreas: Area[];
    t: TranslateFn;
    updateArea: (id: string, updates: Partial<Area>) => Promise<unknown>;
    updateProject: (id: string, updates: Partial<Project>) => void;
};

type OpenProjectTagPickerArgs = {
    projectTagOptions: string[];
    selectedProject: Project | null;
    setSelectedProject: (project: Project | null) => void;
    setShowTagPicker: (visible: boolean) => void;
    setTagDraft: (value: string) => void;
    t: TranslateFn;
    toggleProjectTag: (tag: string) => void;
    updateProject: (id: string, updates: Partial<Project>) => void;
};

export const openProjectAreaPicker = ({
    addArea,
    areaUsage,
    colors,
    deleteArea,
    logProjectError,
    selectedProject,
    setSelectedProject,
    setShowAreaPicker,
    showToast,
    sortAreasByColor,
    sortAreasByName,
    sortedAreas,
    t,
    updateArea,
    updateProject,
}: OpenProjectAreaPickerArgs) => {
    Keyboard.dismiss();

    if (Platform.OS !== 'ios' || !selectedProject) {
        setShowAreaPicker(true);
        return;
    }

    const manageAreasLabel = translateWithFallback(t, 'projects.manageAreas', 'Manage areas');
    const chooseColorLabel = translateWithFallback(t, 'projects.changeColor', 'Choose color');
    const nextLabel = translateWithFallback(t, 'common.next', 'Next');
    const editAreaLabel = translateWithFallback(t, 'projects.editArea', 'Edit area');
    const renameAreaLabel = translateWithFallback(t, 'projects.renameArea', 'Rename area');
    const changeColorLabel = translateWithFallback(t, 'projects.changeColor', 'Change color');

    const setProjectArea = (areaId?: string) => applyLiveProjectUpdate({
        projectId: selectedProject.id,
        updates: { areaId },
        updateProject,
        setSelectedProject,
        onBlocked: () => setShowAreaPicker(false),
    });

    const createAreaWithColor = (
        onCreated: (created: Area) => void,
        logMessage: string,
    ) => {
        Alert.prompt(
            t('projects.areaLabel'),
            `${t('common.add')} ${t('projects.areaLabel')}`,
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: nextLabel,
                    onPress: (value?: string) => {
                        const name = (value ?? '').trim();
                        if (!name) return;

                        ActionSheetIOS.showActionSheetWithOptions(
                            {
                                options: [
                                    t('common.cancel'),
                                    ...colors.map((color) => areaColorLabel(t, color)),
                                ],
                                cancelButtonIndex: 0,
                                title: chooseColorLabel,
                            },
                            async (colorIndex) => {
                                if (colorIndex <= 0) return;
                                const color = colors[colorIndex - 1];
                                if (!color) return;
                                if (!getLiveMutableProject(selectedProject.id)) return;

                                try {
                                    const created = await addArea(name, { color });
                                    if (!created) return;
                                    if (!getLiveMutableProject(selectedProject.id)) return;
                                    onCreated(created);
                                } catch (error) {
                                    logProjectError(logMessage, error);
                                }
                            }
                        );
                    },
                },
            ],
            'plain-text'
        );
    };

    const openIOSAreaEditor = (area: Area) => {
        ActionSheetIOS.showActionSheetWithOptions(
            {
                options: [t('common.cancel'), renameAreaLabel, changeColorLabel],
                cancelButtonIndex: 0,
                title: area.name,
            },
            (editIndex) => {
                if (editIndex === 0) return;

                if (editIndex === 1) {
                    Alert.prompt(
                        renameAreaLabel,
                        area.name,
                        [
                            { text: t('common.cancel'), style: 'cancel' },
                            {
                                text: t('common.save'),
                                onPress: async (value?: string) => {
                                    const nextName = (value ?? '').trim();
                                    if (!nextName || nextName === area.name) return;
                                    try {
                                        await updateArea(area.id, { name: nextName });
                                    } catch (error) {
                                        logProjectError('Failed to rename area on iOS', error);
                                    }
                                },
                            },
                        ],
                        'plain-text',
                        area.name
                    );
                    return;
                }

                ActionSheetIOS.showActionSheetWithOptions(
                    {
                        options: [
                            t('common.cancel'),
                            ...colors.map((color) => (
                                `${area.color === color ? '✓ ' : ''}${areaColorLabel(t, color)}`
                            )),
                        ],
                        cancelButtonIndex: 0,
                        title: changeColorLabel,
                    },
                    async (colorIndex) => {
                        if (colorIndex <= 0) return;
                        const color = colors[colorIndex - 1];
                        if (!color || color === area.color) return;

                        try {
                            await updateArea(area.id, { color });
                        } catch (error) {
                            logProjectError('Failed to change area color on iOS', error);
                        }
                    }
                );
            }
        );
    };

    const openIOSAreaManager = () => {
        ActionSheetIOS.showActionSheetWithOptions(
            {
                options: [
                    t('common.cancel'),
                    `${t('common.add')} ${t('projects.areaLabel')}`,
                    editAreaLabel,
                    t('projects.sortByName'),
                    t('projects.sortByColor'),
                    t('common.delete'),
                ],
                cancelButtonIndex: 0,
                title: manageAreasLabel,
            },
            (manageIndex) => {
                if (manageIndex === 0) return;
                if (manageIndex === 1) {
                    createAreaWithColor((created) => {
                        setProjectArea(created.id);
                    }, 'Failed to create area from iOS manager');
                    return;
                }
                if (manageIndex === 2) {
                    if (sortedAreas.length === 0) {
                        showToast({
                            title: tFallback(t, 'common.notice', 'Notice'),
                            message: t('projects.noArea'),
                            tone: 'warning',
                        });
                        return;
                    }

                    ActionSheetIOS.showActionSheetWithOptions(
                        {
                            options: [t('common.cancel'), ...sortedAreas.map((area) => area.name)],
                            cancelButtonIndex: 0,
                            title: editAreaLabel,
                        },
                        (areaIndex) => {
                            if (areaIndex <= 0) return;
                            const target = sortedAreas[areaIndex - 1];
                            if (!target) return;
                            openIOSAreaEditor(target);
                        }
                    );
                    return;
                }
                if (manageIndex === 3) {
                    sortAreasByName();
                    return;
                }
                if (manageIndex === 4) {
                    sortAreasByColor();
                    return;
                }

                const deletableAreas = sortedAreas.filter((area) => (areaUsage.get(area.id) || 0) === 0);
                if (deletableAreas.length === 0) {
                    showToast({
                        title: tFallback(t, 'common.notice', 'Notice'),
                        message: tFallback(t, 'projects.areaInUse', 'Area has projects.'),
                        tone: 'warning',
                    });
                    return;
                }

                ActionSheetIOS.showActionSheetWithOptions(
                    {
                        options: [t('common.cancel'), ...deletableAreas.map((area) => `${t('common.delete')} ${area.name}`)],
                        cancelButtonIndex: 0,
                        destructiveButtonIndex: deletableAreas.length > 0 ? 1 : undefined,
                        title: t('common.delete'),
                    },
                    (deleteIndex) => {
                        if (deleteIndex <= 0) return;
                        const target = deletableAreas[deleteIndex - 1];
                        if (!target) return;
                        deleteArea(target.id);
                    }
                );
            }
        );
    };

    ActionSheetIOS.showActionSheetWithOptions(
        {
            options: [
                t('common.cancel'),
                t('projects.noArea'),
                `${t('common.add')} ${t('projects.areaLabel')}`,
                manageAreasLabel,
                ...sortedAreas.map((area) => area.name),
            ],
            cancelButtonIndex: 0,
            title: t('projects.areaLabel'),
        },
        (buttonIndex) => {
            if (buttonIndex === 0) return;
            if (buttonIndex === 1) {
                setProjectArea(undefined);
                return;
            }
            if (buttonIndex === 2) {
                createAreaWithColor((created) => {
                    setProjectArea(created.id);
                }, 'Failed to create area from iOS action sheet');
                return;
            }
            if (buttonIndex === 3) {
                openIOSAreaManager();
                return;
            }
            const pickedArea = sortedAreas[buttonIndex - 4];
            if (!pickedArea) return;
            setProjectArea(pickedArea.id);
        }
    );
};

export const openProjectTagPicker = ({
    projectTagOptions,
    selectedProject,
    setSelectedProject,
    setShowTagPicker,
    setTagDraft,
    t,
    toggleProjectTag,
    updateProject,
}: OpenProjectTagPickerArgs) => {
    Keyboard.dismiss();

    if (Platform.OS !== 'ios' || !selectedProject) {
        setTagDraft('');
        setShowTagPicker(true);
        return;
    }

    const existingTags = selectedProject.tagIds || [];
    const tagOptions = projectTagOptions.slice(0, 25);

    ActionSheetIOS.showActionSheetWithOptions(
        {
            options: [
                t('common.cancel'),
                `${t('common.add')} ${t('taskEdit.tagsLabel')}`,
                t('common.clear'),
                ...tagOptions.map((tag) => (existingTags.includes(tag) ? `✓ ${tag}` : tag)),
            ],
            cancelButtonIndex: 0,
            title: t('taskEdit.tagsLabel'),
        },
        (buttonIndex) => {
            if (buttonIndex === 0) return;
            if (buttonIndex === 1) {
                Alert.prompt(
                    t('taskEdit.tagsLabel'),
                    `${t('common.add')} ${t('taskEdit.tagsLabel')}`,
                    [
                        { text: t('common.cancel'), style: 'cancel' },
                        {
                            text: t('common.save'),
                            onPress: (value?: string) => {
                                const normalized = normalizeProjectTag(value ?? '');
                                if (!normalized) return;
                                applyLiveProjectUpdate({
                                    projectId: selectedProject.id,
                                    updates: (project) => ({
                                        tagIds: Array.from(new Set([...(project.tagIds || []), normalized])),
                                    }),
                                    updateProject,
                                    setSelectedProject,
                                    onBlocked: () => setShowTagPicker(false),
                                });
                            },
                        },
                    ],
                    'plain-text'
                );
                return;
            }
            if (buttonIndex === 2) {
                applyLiveProjectUpdate({
                    projectId: selectedProject.id,
                    updates: { tagIds: [] },
                    updateProject,
                    setSelectedProject,
                    onBlocked: () => setShowTagPicker(false),
                });
                return;
            }
            const pickedTag = tagOptions[buttonIndex - 3];
            if (!pickedTag) return;
            toggleProjectTag(pickedTag);
        }
    );
};
