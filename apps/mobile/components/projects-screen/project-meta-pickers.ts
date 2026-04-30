import { Area, Project, translateWithFallback, type TranslateFn } from '@mindwtr/core';
import { ActionSheetIOS, Alert, Keyboard, Platform } from 'react-native';

import type { ToastOptions } from '@/contexts/toast-context';
import { normalizeProjectTag } from '@/components/projects-screen/projects-screen.utils';

type AreaColorMeta = {
    nameKey: string;
    swatch: string;
};

type OpenProjectAreaPickerArgs = {
    addArea: (name: string, options: { color: string }) => Promise<Area | null | undefined>;
    areaUsage: Map<string, number>;
    colorDisplayByHex: Record<string, AreaColorMeta>;
    colors: readonly string[];
    deleteArea: (id: string) => void;
    logProjectError: (message: string, error?: unknown) => void;
    selectedProject: Project | null;
    setSelectedProject: (project: Project | null) => void;
    setShowAreaPicker: (visible: boolean) => void;
    setShowStatusMenu: (visible: boolean) => void;
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
    setShowStatusMenu: (visible: boolean) => void;
    setShowTagPicker: (visible: boolean) => void;
    setTagDraft: (value: string) => void;
    t: TranslateFn;
    toggleProjectTag: (tag: string) => void;
    updateProject: (id: string, updates: Partial<Project>) => void;
};

export const openProjectAreaPicker = ({
    addArea,
    areaUsage,
    colorDisplayByHex,
    colors,
    deleteArea,
    logProjectError,
    selectedProject,
    setSelectedProject,
    setShowAreaPicker,
    setShowStatusMenu,
    showToast,
    sortAreasByColor,
    sortAreasByName,
    sortedAreas,
    t,
    updateArea,
    updateProject,
}: OpenProjectAreaPickerArgs) => {
    Keyboard.dismiss();
    setShowStatusMenu(false);

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

    const setProjectArea = (areaId?: string) => {
        updateProject(selectedProject.id, { areaId });
        setSelectedProject({ ...selectedProject, areaId });
    };

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
                                    ...colors.map((color) => {
                                        const colorMeta = colorDisplayByHex[color] ?? { nameKey: '', swatch: '◯' };
                                        const colorName = colorMeta.nameKey ? t(colorMeta.nameKey) : color.toUpperCase();
                                        return `${colorMeta.swatch} ${colorName}`;
                                    }),
                                ],
                                cancelButtonIndex: 0,
                                title: chooseColorLabel,
                            },
                            async (colorIndex) => {
                                if (colorIndex <= 0) return;
                                const color = colors[colorIndex - 1];
                                if (!color) return;

                                try {
                                    const created = await addArea(name, { color });
                                    if (!created) return;
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
                            ...colors.map((color) => {
                                const colorMeta = colorDisplayByHex[color] ?? { nameKey: '', swatch: '◯' };
                                const colorName = colorMeta.nameKey ? t(colorMeta.nameKey) : color.toUpperCase();
                                return `${area.color === color ? '✓ ' : ''}${colorMeta.swatch} ${colorName}`;
                            }),
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
                            title: t('common.notice') || 'Notice',
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
                        title: t('common.notice') || 'Notice',
                        message: t('projects.areaInUse') || 'Area has projects.',
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
    setShowStatusMenu,
    setShowTagPicker,
    setTagDraft,
    t,
    toggleProjectTag,
    updateProject,
}: OpenProjectTagPickerArgs) => {
    Keyboard.dismiss();
    setShowStatusMenu(false);

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
                                const next = Array.from(new Set([...(selectedProject.tagIds || []), normalized]));
                                updateProject(selectedProject.id, { tagIds: next });
                                setSelectedProject({ ...selectedProject, tagIds: next });
                            },
                        },
                    ],
                    'plain-text'
                );
                return;
            }
            if (buttonIndex === 2) {
                updateProject(selectedProject.id, { tagIds: [] });
                setSelectedProject({ ...selectedProject, tagIds: [] });
                return;
            }
            const pickedTag = tagOptions[buttonIndex - 3];
            if (!pickedTag) return;
            toggleProjectTag(pickedTag);
        }
    );
};
