import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, Modal, Alert, Pressable, ScrollView, SectionList, Dimensions, Platform, Keyboard, ActionSheetIOS } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Area, Attachment, DEFAULT_PROJECT_COLOR, generateUUID, getAttachmentDisplayTitle, normalizeLinkAttachmentInput, Project, Task, useTaskStore, validateAttachmentForUpload } from '@mindwtr/core';
import DateTimePicker from '@react-native-community/datetimepicker';
import * as DocumentPicker from 'expo-document-picker';
import * as Linking from 'expo-linking';
import * as Sharing from 'expo-sharing';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { projectsScreenStyles as styles } from '@/app/(drawer)/projects-screen.styles';
import {
  formatProjectReviewDate,
  normalizeProjectTag,
  resolveAttachmentValidationMessage,
} from '@/app/(drawer)/projects-screen.utils';
import { ProjectImagePreviewModal, ProjectLinkModal, ProjectTagPickerModal } from '@/components/projects-screen/ProjectOverlayModals';
import { ProjectRow } from '@/components/projects-screen/ProjectRow';
import { TaskEditModal } from '@/components/task-edit-modal';
import { useProjectFiltering, type ProjectSectionItem } from '@/hooks/use-project-filtering';
import { TaskList } from '../../components/task-list';
import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';
import { useLanguage } from '../../contexts/language-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { MarkdownText } from '../../components/markdown-text';
import { ListSectionHeader, defaultListContentStyle } from '@/components/list-layout';
import { ensureAttachmentAvailable } from '../../lib/attachment-sync';
import { AttachmentProgressIndicator } from '../../components/AttachmentProgressIndicator';
import { logError, logWarn } from '../../lib/app-log';
import { AREA_FILTER_ALL, AREA_FILTER_NONE } from '@/lib/area-filter';
import { openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';

export default function ProjectsScreen() {
  const { projects, tasks, addProject, updateProject, deleteProject, toggleProjectFocus, addArea, updateArea, deleteArea, reorderAreas, updateTask, setHighlightTask } = useTaskStore();
  const { t } = useLanguage();
  const tc = useThemeColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const statusPalette: Record<Project['status'], { text: string; bg: string; border: string }> = {
    active: { text: tc.tint, bg: `${tc.tint}22`, border: tc.tint },
    waiting: { text: '#F59E0B', bg: '#F59E0B22', border: '#F59E0B' },
    someday: { text: '#A855F7', bg: '#A855F722', border: '#A855F7' },
    archived: { text: tc.secondaryText, bg: tc.filterBg, border: tc.border },
  };
  const [newProjectTitle, setNewProjectTitle] = useState('');
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [showNotesPreview, setShowNotesPreview] = useState(false);
  const [showProjectMeta, setShowProjectMeta] = useState(false);
  const [showReviewPicker, setShowReviewPicker] = useState(false);
  const [showStatusMenu, setShowStatusMenu] = useState(false);
  const [linkModalVisible, setLinkModalVisible] = useState(false);
  const [imagePreviewAttachment, setImagePreviewAttachment] = useState<Attachment | null>(null);
  const [linkInput, setLinkInput] = useState('');
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [showAreaPicker, setShowAreaPicker] = useState(false);
  const [showAreaManager, setShowAreaManager] = useState(false);
  const [newAreaName, setNewAreaName] = useState('');
  const [newAreaColor, setNewAreaColor] = useState('#3b82f6');
  const [expandedAreaColorId, setExpandedAreaColorId] = useState<string | null>(null);
  const { projectId, taskId } = useLocalSearchParams<{ projectId?: string; taskId?: string }>();
  const lastOpenedTaskIdRef = useRef<string | null>(null);
  const ALL_TAGS = '__all__';
  const NO_TAGS = '__none__';
  const ALL_AREAS = AREA_FILTER_ALL;
  const NO_AREA = AREA_FILTER_NONE;
  const [selectedTagFilter, setSelectedTagFilter] = useState(ALL_TAGS);
  const [showTagPicker, setShowTagPicker] = useState(false);
  const {
    areaById,
    resolvedAreaFilter: selectedAreaFilter,
    sortedAreas,
  } = useMobileAreaFilter();

  const logProjectError = useCallback((message: string, error?: unknown) => {
    if (!error) return;
    void logError(error, { scope: 'project', extra: { message } });
  }, []);
  const [showTagFilter, setShowTagFilter] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const windowHeight = Dimensions.get('window').height;
  const pickerCardMaxHeight = Math.min(windowHeight * 0.8, 560);
  const areaListMaxHeight = Math.min(windowHeight * 0.4, 280);
  const areaManagerListMaxHeight = Math.min(windowHeight * 0.45, 320);
  const overlayModalPresentation = Platform.OS === 'ios' ? 'overFullScreen' : 'fullScreen';

  const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];
  const colorDisplayByHex: Record<string, { nameKey: string; swatch: string }> = {
    '#3b82f6': { nameKey: 'projects.colorBlue', swatch: '🔵' },
    '#10b981': { nameKey: 'projects.colorGreen', swatch: '🟢' },
    '#f59e0b': { nameKey: 'projects.colorAmber', swatch: '🟠' },
    '#ef4444': { nameKey: 'projects.colorRed', swatch: '🔴' },
    '#8b5cf6': { nameKey: 'projects.colorPurple', swatch: '🟣' },
    '#ec4899': { nameKey: 'projects.colorPink', swatch: '🩷' },
  };
  const {
    areaUsage,
    focusedCount,
    groupedProjects,
    projectTagOptions,
    tagFilterOptions,
  } = useProjectFiltering({
    projects,
    tasks,
    sortedAreas,
    areaById,
    selectedTagFilter,
    selectedAreaFilter,
    allTagsValue: ALL_TAGS,
    noTagsValue: NO_TAGS,
    t,
  });

  const openProject = useCallback((project: Project) => {
    setSelectedProject(project);
    setNotesExpanded(false);
    setShowNotesPreview(false);
    setShowProjectMeta(false);
    setShowReviewPicker(false);
    setShowStatusMenu(false);
    setLinkModalVisible(false);
    setLinkInput('');
  }, []);

  useEffect(() => {
    if (!projectId || typeof projectId !== 'string') return;
    const project = projects.find((item) => item.id === projectId && !item.deletedAt);
    if (project) {
      openProject(project);
    }
  }, [projectId, projects, openProject]);

  useEffect(() => {
    if (!taskId || typeof taskId !== 'string') return;
    if (!selectedProject || selectedProject.id !== projectId) return;
    if (lastOpenedTaskIdRef.current === taskId) return;
    const task = tasks.find((item) => item.id === taskId && !item.deletedAt);
    if (!task || task.projectId !== selectedProject.id) return;
    lastOpenedTaskIdRef.current = taskId;
    setHighlightTask(task.id);
    setEditingTask(task);
  }, [taskId, projectId, selectedProject, tasks, setHighlightTask]);

  const sortAreasByName = () => {
    const reordered = [...sortedAreas]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((area) => area.id);
    reorderAreas(reordered);
  };

  const sortAreasByColor = () => {
    const reordered = [...sortedAreas]
      .sort((a, b) => {
        const colorA = (a.color || '').toLowerCase();
        const colorB = (b.color || '').toLowerCase();
        if (colorA && colorB && colorA !== colorB) return colorA.localeCompare(colorB);
        if (colorA && !colorB) return -1;
        if (!colorA && colorB) return 1;
        return a.name.localeCompare(b.name);
      })
      .map((area) => area.id);
    reorderAreas(reordered);
  };

  const toggleProjectTag = (tag: string) => {
    if (!selectedProject) return;
    const normalized = normalizeProjectTag(tag);
    if (!normalized) return;
    const current = selectedProject.tagIds || [];
    const exists = current.includes(normalized);
    const next = exists ? current.filter((t) => t !== normalized) : [...current, normalized];
    updateProject(selectedProject.id, { tagIds: next });
    setSelectedProject({ ...selectedProject, tagIds: next });
  };

  const renderSectionItem = ({ item }: { item: ProjectSectionItem }) => {
    return (
      <ProjectRow
        project={item.data}
        tasks={tasks}
        areaById={areaById}
        tc={tc}
        focusedCount={focusedCount}
        statusPalette={statusPalette}
        t={t}
        onDeleteProject={deleteProject}
        onOpenProject={openProject}
        onToggleProjectFocus={toggleProjectFocus}
      />
    );
  };


  const handleAddProject = () => {
    if (newProjectTitle.trim()) {
      const inferredAreaId =
        selectedAreaFilter !== ALL_AREAS && selectedAreaFilter !== NO_AREA && areaById.has(selectedAreaFilter)
          ? selectedAreaFilter
          : undefined;
      const areaColor = inferredAreaId ? areaById.get(inferredAreaId)?.color : undefined;
      addProject(newProjectTitle, areaColor || DEFAULT_PROJECT_COLOR, {
        areaId: inferredAreaId,
      });
      setNewProjectTitle('');
    }
  };

  const persistSelectedProjectEdits = (project: Project | null) => {
    if (!project) return;
    const original = projects.find((p) => p.id === project.id);
    if (!original) return;

    const nextTitle = project.title.trim();
    const nextArea = project.areaId || undefined;
    const prevArea = original.areaId || undefined;

    const updates: Partial<Project> = {};
    if (nextTitle && nextTitle !== original.title) updates.title = nextTitle;
    if (nextArea !== prevArea) updates.areaId = nextArea;
    if ((project.tagIds || []).join('|') !== (original.tagIds || []).join('|')) {
      updates.tagIds = project.tagIds || [];
    }

    if (Object.keys(updates).length > 0) {
      updateProject(project.id, updates);
    }
  };

  const closeProjectDetail = () => {
    persistSelectedProjectEdits(selectedProject);
    setSelectedProject(null);
    setNotesExpanded(false);
    setShowNotesPreview(false);
    setShowProjectMeta(false);
    setShowReviewPicker(false);
    setShowStatusMenu(false);
    setLinkModalVisible(false);
    setLinkInput('');
    setShowAreaPicker(false);
    setShowTagPicker(false);
    if (projectId && router.canGoBack()) {
      router.back();
    }
  };

  const handleSetProjectStatus = (status: Project['status']) => {
    if (!selectedProject) return;
    updateProject(selectedProject.id, { status });
    setSelectedProject({ ...selectedProject, status });
    setShowStatusMenu(false);
  };

  const handleArchiveSelectedProject = () => {
    if (!selectedProject) return;
    Alert.alert(
      t('projects.title'),
      t('projects.archiveConfirm'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('projects.archive'),
          style: 'destructive',
          onPress: () => {
            updateProject(selectedProject.id, { status: 'archived' });
            setSelectedProject({ ...selectedProject, status: 'archived' });
          }
        }
      ]
    );
  };

  const openAreaPicker = () => {
    Keyboard.dismiss();
    setShowStatusMenu(false);
    if (Platform.OS === 'ios' && selectedProject) {
      const manageAreasLabel = (() => {
        const translated = t('projects.manageAreas');
        return translated === 'projects.manageAreas' ? 'Manage areas' : translated;
      })();
      const chooseColorLabel = (() => {
        const translated = t('projects.changeColor');
        return translated === 'projects.changeColor' ? 'Choose color' : translated;
      })();
      const nextLabel = (() => {
        const translated = t('common.next');
        return translated === 'common.next' ? 'Next' : translated;
      })();
      const createAreaWithColor = (onCreated: (created: Area) => void, logMessage: string) => {
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
      const openIOSAreaManager = () => {
        const editAreaLabel = (() => {
          const translated = t('projects.editArea');
          return translated === 'projects.editArea' ? 'Edit area' : translated;
        })();
        const renameAreaLabel = (() => {
          const translated = t('projects.renameArea');
          return translated === 'projects.renameArea' ? 'Rename area' : translated;
        })();
        const changeColorLabel = (() => {
          const translated = t('projects.changeColor');
          return translated === 'projects.changeColor' ? 'Change color' : translated;
        })();
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
                updateProject(selectedProject.id, { areaId: created.id });
                setSelectedProject({ ...selectedProject, areaId: created.id });
              }, 'Failed to create area from iOS manager');
              return;
            }
            if (manageIndex === 2) {
              if (sortedAreas.length === 0) {
                Alert.alert(t('common.notice') || 'Notice', t('projects.noArea'));
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
              Alert.alert(t('common.notice') || 'Notice', t('projects.areaInUse') || 'Area has projects.');
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
      const options = [
        t('common.cancel'),
        t('projects.noArea'),
        `${t('common.add')} ${t('projects.areaLabel')}`,
        manageAreasLabel,
        ...sortedAreas.map((area) => area.name),
      ];
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options,
          cancelButtonIndex: 0,
          title: t('projects.areaLabel'),
        },
        (buttonIndex) => {
          if (!selectedProject) return;
          if (buttonIndex === 0) return;
          if (buttonIndex === 1) {
            updateProject(selectedProject.id, { areaId: undefined });
            setSelectedProject({ ...selectedProject, areaId: undefined });
            return;
          }
          if (buttonIndex === 2) {
            createAreaWithColor((created) => {
              updateProject(selectedProject.id, { areaId: created.id });
              setSelectedProject({ ...selectedProject, areaId: created.id });
            }, 'Failed to create area from iOS action sheet');
            return;
          }
          if (buttonIndex === 3) {
            openIOSAreaManager();
            return;
          }
          const pickedArea = sortedAreas[buttonIndex - 4];
          if (!pickedArea) return;
          updateProject(selectedProject.id, { areaId: pickedArea.id });
          setSelectedProject({ ...selectedProject, areaId: pickedArea.id });
        }
      );
      return;
    }
    setShowAreaPicker(true);
  };

  const openTagPicker = () => {
    Keyboard.dismiss();
    setShowStatusMenu(false);
    if (Platform.OS === 'ios' && selectedProject) {
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
      return;
    }
    setTagDraft('');
    setShowTagPicker(true);
  };

  const updateAttachmentStatus = (
    attachments: Attachment[],
    id: string,
    status: Attachment['localStatus']
  ): Attachment[] =>
    attachments.map((item): Attachment =>
      item.id === id ? { ...item, localStatus: status } : item
    );

  const isImageAttachment = useCallback((attachment: Attachment) => {
    const mime = attachment.mimeType?.toLowerCase();
    if (mime?.startsWith('image/')) return true;
    return /\.(png|jpg|jpeg|gif|webp|heic|heif)$/i.test(attachment.uri);
  }, []);

  const openAttachment = async (attachment: Attachment) => {
    const shouldDownload = attachment.kind === 'file'
      && attachment.cloudKey
      && (attachment.localStatus === 'missing' || !attachment.uri);
    if (shouldDownload && selectedProject) {
      const next = updateAttachmentStatus(
        selectedProject.attachments || [],
        attachment.id,
        'downloading'
      );
      updateProject(selectedProject.id, { attachments: next });
      setSelectedProject({ ...selectedProject, attachments: next });
    }

    const resolved = await ensureAttachmentAvailable(attachment);
    if (!resolved) {
      if (shouldDownload && selectedProject) {
        const next = updateAttachmentStatus(
          selectedProject.attachments || [],
          attachment.id,
          'missing'
        );
        updateProject(selectedProject.id, { attachments: next });
        setSelectedProject({ ...selectedProject, attachments: next });
      }
      const message = attachment.kind === 'file' ? t('attachments.missing') : t('attachments.fileNotSupported');
      Alert.alert(t('attachments.title'), message);
      return;
    }
    if (resolved.uri !== attachment.uri || resolved.localStatus !== attachment.localStatus) {
      const next = (selectedProject?.attachments || []).map((item): Attachment =>
        item.id === resolved.id ? { ...item, ...resolved } : item
      );
      if (selectedProject) {
        updateProject(selectedProject.id, { attachments: next });
        setSelectedProject({ ...selectedProject, attachments: next });
      }
    }

    if (resolved.kind === 'link') {
      Linking.openURL(resolved.uri).catch((error) => logProjectError('Failed to open attachment URL', error));
      return;
    }
    if (isImageAttachment(resolved)) {
      setImagePreviewAttachment(resolved);
      return;
    }

    const available = await Sharing.isAvailableAsync().catch((error) => {
      void logWarn('[Sharing] availability check failed', {
        scope: 'project',
        extra: { error: error instanceof Error ? error.message : String(error) },
      });
      return false;
    });
    if (available) {
      Sharing.shareAsync(resolved.uri).catch((error) => logProjectError('Failed to share attachment', error));
    } else {
      Linking.openURL(resolved.uri).catch((error) => logProjectError('Failed to open attachment URL', error));
    }
  };

  useEffect(() => {
    if (!selectedProject) {
      setImagePreviewAttachment(null);
    }
  }, [selectedProject]);

  const downloadAttachment = async (attachment: Attachment) => {
    if (!selectedProject) return;
    const shouldDownload = attachment.kind === 'file'
      && attachment.cloudKey
      && (attachment.localStatus === 'missing' || !attachment.uri);
    if (shouldDownload) {
      const next = updateAttachmentStatus(
        selectedProject.attachments || [],
        attachment.id,
        'downloading'
      );
      updateProject(selectedProject.id, { attachments: next });
      setSelectedProject({ ...selectedProject, attachments: next });
    }

    const resolved = await ensureAttachmentAvailable(attachment);
    if (!resolved) {
      const next = updateAttachmentStatus(
        selectedProject.attachments || [],
        attachment.id,
        'missing'
      );
      updateProject(selectedProject.id, { attachments: next });
      setSelectedProject({ ...selectedProject, attachments: next });
      const message = attachment.kind === 'file' ? t('attachments.missing') : t('attachments.fileNotSupported');
      Alert.alert(t('attachments.title'), message);
      return;
    }
    if (resolved.uri !== attachment.uri || resolved.localStatus !== attachment.localStatus) {
      const next = (selectedProject.attachments || []).map((item): Attachment =>
        item.id === resolved.id ? { ...item, ...resolved } : item
      );
      updateProject(selectedProject.id, { attachments: next });
      setSelectedProject({ ...selectedProject, attachments: next });
    }
  };

  const addProjectFileAttachment = async () => {
    if (!selectedProject) return;
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: false,
      multiple: false,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    const size = asset.size;
    if (typeof size === 'number') {
      const validation = await validateAttachmentForUpload(
        {
          id: 'pending',
          kind: 'file',
          title: asset.name || 'file',
          uri: asset.uri,
          mimeType: asset.mimeType,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        size
      );
      if (!validation.valid) {
        Alert.alert(t('attachments.title'), resolveAttachmentValidationMessage(validation.error, t));
        return;
      }
    }
    const now = new Date().toISOString();
    const attachment: Attachment = {
      id: generateUUID(),
      kind: 'file',
      title: asset.name || 'file',
      uri: asset.uri,
      mimeType: asset.mimeType,
      size: asset.size,
      createdAt: now,
      updatedAt: now,
      localStatus: 'available',
    };
    const next = [...(selectedProject.attachments || []), attachment];
    updateProject(selectedProject.id, { attachments: next });
    setSelectedProject({ ...selectedProject, attachments: next });
  };

  const confirmAddProjectLink = () => {
    if (!selectedProject) return;
    const normalized = normalizeLinkAttachmentInput(linkInput);
    if (!normalized.uri) return;
    const now = new Date().toISOString();
    const attachment: Attachment = {
      id: generateUUID(),
      kind: normalized.kind,
      title: normalized.title,
      uri: normalized.uri,
      createdAt: now,
      updatedAt: now,
    };
    const next = [...(selectedProject.attachments || []), attachment];
    updateProject(selectedProject.id, { attachments: next });
    setSelectedProject({ ...selectedProject, attachments: next });
    setLinkModalVisible(false);
    setLinkInput('');
  };

  const removeProjectAttachment = (id: string) => {
    if (!selectedProject) return;
    const now = new Date().toISOString();
    const next = (selectedProject.attachments || []).map((a) =>
      a.id === id ? { ...a, deletedAt: now, updatedAt: now } : a
    );
    updateProject(selectedProject.id, { attachments: next });
    setSelectedProject({ ...selectedProject, attachments: next });
  };


  const modalHeaderStyle = [styles.modalHeader, {
    borderBottomColor: tc.border,
    backgroundColor: tc.cardBg,
    paddingTop: Math.max(insets.top, 10),
    paddingBottom: 10,
  }];

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={[styles.container, { backgroundColor: tc.bg }]}>
      <View style={[styles.inputContainer, { borderBottomColor: tc.border }]}>
        <TextInput
          style={[styles.input, { borderColor: tc.border, backgroundColor: tc.inputBg, color: tc.text }]}
          placeholder={t('projects.addPlaceholder')}
          placeholderTextColor={tc.secondaryText}
          value={newProjectTitle}
          onChangeText={setNewProjectTitle}
          onSubmitEditing={handleAddProject}
          returnKeyType="done"
        />
        <View style={styles.filterSection}>
          <TouchableOpacity
            style={styles.filterHeader}
            onPress={() => setShowTagFilter((prev) => !prev)}
          >
            <Text style={[styles.tagFilterLabel, { color: tc.text }]}>{t('projects.tagFilter')}</Text>
            <Text style={[styles.filterToggleText, { color: tc.secondaryText }]}>
              {showTagFilter ? t('filters.hide') : t('filters.show')}
            </Text>
          </TouchableOpacity>
          {showTagFilter && (
            <View style={styles.tagFilterChips}>
              <TouchableOpacity
                style={[
                  styles.tagFilterChip,
                  selectedTagFilter === ALL_TAGS
                    ? { borderColor: tc.tint, backgroundColor: tc.tint }
                    : { borderColor: tc.border, backgroundColor: tc.cardBg },
                ]}
                onPress={() => setSelectedTagFilter(ALL_TAGS)}
              >
                <Text
                  style={[
                    styles.tagFilterText,
                    { color: selectedTagFilter === ALL_TAGS ? tc.onTint : tc.text },
                  ]}
                >
                  {t('projects.allTags')}
                </Text>
              </TouchableOpacity>
              {tagFilterOptions.list.map((tag) => (
                <TouchableOpacity
                  key={tag}
                  style={[
                    styles.tagFilterChip,
                    selectedTagFilter === tag
                      ? { borderColor: tc.tint, backgroundColor: tc.tint }
                      : { borderColor: tc.border, backgroundColor: tc.cardBg },
                  ]}
                  onPress={() => setSelectedTagFilter(tag)}
                >
                  <Text
                    style={[
                      styles.tagFilterText,
                      { color: selectedTagFilter === tag ? tc.onTint : tc.text },
                    ]}
                  >
                    {tag}
                  </Text>
                </TouchableOpacity>
              ))}
              {tagFilterOptions.hasNoTags && (
                <TouchableOpacity
                  style={[
                    styles.tagFilterChip,
                    selectedTagFilter === NO_TAGS
                      ? { borderColor: tc.tint, backgroundColor: tc.tint }
                      : { borderColor: tc.border, backgroundColor: tc.cardBg },
                  ]}
                  onPress={() => setSelectedTagFilter(NO_TAGS)}
                >
                  <Text
                    style={[
                      styles.tagFilterText,
                      { color: selectedTagFilter === NO_TAGS ? tc.onTint : tc.text },
                    ]}
                  >
                    {t('projects.noTags')}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          )}
        </View>
        <TouchableOpacity
          onPress={handleAddProject}
          style={[
            styles.addButton,
            { backgroundColor: tc.tint },
            !newProjectTitle.trim() && styles.addButtonDisabled,
          ]}
          disabled={!newProjectTitle.trim()}
        >
          <Text style={styles.addButtonText}>{t('projects.add')}</Text>
        </TouchableOpacity>
      </View>

      <SectionList
        sections={groupedProjects}
        keyExtractor={(item) => `${item.type}-${item.data.id}`}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={defaultListContentStyle}
        style={{ flex: 1 }}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={[styles.emptyText, { color: tc.secondaryText }]}>{t('projects.empty')}</Text>
          </View>
        }
        renderSectionHeader={({ section }) => (
          <ListSectionHeader title={section.title} tc={tc} />
        )}
        renderItem={({ item }) => renderSectionItem({ item })}
      />

      <Modal
        visible={!!selectedProject}
        animationType="slide"
        presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
        allowSwipeDismissal
        onRequestClose={closeProjectDetail}
      >
                <SafeAreaView
                  style={{ flex: 1, backgroundColor: tc.bg }}
                  edges={['left', 'right', 'bottom']}
                >
                  {selectedProject ? (
                    <>
                <View style={modalHeaderStyle}>
                  <TouchableOpacity onPress={closeProjectDetail} style={styles.backButton} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                    <Text style={[styles.backButtonText, { color: tc.tint }]}>{t('common.back') || 'Back'}</Text>
                  </TouchableOpacity>
                  <TextInput
                    style={[styles.modalTitle, { color: tc.text, marginLeft: 8, flex: 1 }]}
                    value={selectedProject.title}
                    onChangeText={(text) => setSelectedProject({ ...selectedProject, title: text })}
                    onSubmitEditing={() => {
                      const title = selectedProject.title.trim();
                      if (!title) return;
                      updateProject(selectedProject.id, { title });
                      setSelectedProject({ ...selectedProject, title });
                    }}
                    onEndEditing={() => {
                      const title = selectedProject.title.trim();
                      if (!title) return;
                      updateProject(selectedProject.id, { title });
                      setSelectedProject({ ...selectedProject, title });
                    }}
                    returnKeyType="done"
                  />
                  <TouchableOpacity
                    onPress={() => {
                      updateProject(selectedProject.id, { isSequential: !selectedProject.isSequential });
                      setSelectedProject({ ...selectedProject, isSequential: !selectedProject.isSequential });
                    }}
                    style={[
                      styles.sequentialToggle,
                      selectedProject.isSequential && styles.sequentialToggleActive
                    ]}
                  >
                    <Text style={[
                      styles.sequentialToggleText,
                      selectedProject.isSequential && styles.sequentialToggleTextActive
                    ]}>
                      {selectedProject.isSequential ? '📋 Seq' : '⏸ Par'}
                    </Text>
                  </TouchableOpacity>
                </View>
                <ScrollView
                  style={{ flex: 1 }}
                  contentContainerStyle={styles.projectDetailScroll}
                  keyboardShouldPersistTaps="always"
                >

                <View style={[styles.statusBlock, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
                  <View style={styles.statusActionsRow}>
                    <Text style={[styles.statusLabel, { color: tc.secondaryText }]}>{t('projects.statusLabel')}</Text>
                    <TouchableOpacity
                      onPress={() => setShowStatusMenu((prev) => !prev)}
                      style={[
                        styles.statusPicker,
                        {
                          backgroundColor: statusPalette[selectedProject.status]?.bg ?? tc.filterBg,
                          borderColor: statusPalette[selectedProject.status]?.border ?? tc.border,
                        },
                      ]}
                    >
                      <Text style={[styles.statusPickerText, { color: statusPalette[selectedProject.status]?.text ?? tc.text }]}>
                        {selectedProject.status === 'active'
                          ? t('status.active')
                          : selectedProject.status === 'waiting'
                            ? t('status.waiting')
                            : t('status.someday')}
                      </Text>
                      <Text style={[styles.statusPickerText, { color: statusPalette[selectedProject.status]?.text ?? tc.text }]}>▾</Text>
                    </TouchableOpacity>
                    <View style={{ flex: 1 }} />
                    {selectedProject.status === 'archived' ? (
                      <TouchableOpacity
                        onPress={() => handleSetProjectStatus('active')}
                        style={[styles.statusButton, styles.reactivateButton]}
                      >
                        <Text style={[styles.statusButtonText, styles.reactivateText]}>
                          {t('projects.reactivate')}
                        </Text>
                      </TouchableOpacity>
                    ) : (
                      <TouchableOpacity
                        onPress={handleArchiveSelectedProject}
                        style={[styles.statusButton, styles.archiveButton]}
                      >
                        <Text style={[styles.statusButtonText, styles.archiveText]}>
                          {t('projects.archive')}
                        </Text>
                      </TouchableOpacity>
                    )}
                  </View>
                  {showStatusMenu && (
                    <View style={[styles.statusMenu, { backgroundColor: tc.inputBg, borderColor: tc.border }]}>
                      {(['active', 'waiting', 'someday'] as const).map((status) => {
                        const isActive = selectedProject.status === status;
                        const palette = statusPalette[status];
                        return (
                          <TouchableOpacity
                            key={status}
                            onPress={() => handleSetProjectStatus(status)}
                            style={[
                              styles.statusMenuItem,
                              isActive && { backgroundColor: tc.filterBg },
                            ]}
                          >
                            <View style={[styles.statusDot, { backgroundColor: palette?.border ?? tc.border }]} />
                            <Text style={[styles.statusMenuText, { color: palette?.text ?? tc.text }]}>
                              {status === 'active'
                                ? t('status.active')
                                : status === 'waiting'
                                  ? t('status.waiting')
                                  : t('status.someday')}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  )}
                </View>

                <View style={[styles.detailsToggle, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                  <TouchableOpacity
                    style={styles.detailsToggleButton}
                    onPress={() => setShowProjectMeta((prev) => !prev)}
                  >
                    <Text style={[styles.detailsToggleText, { color: tc.text }]}>
                      {showProjectMeta ? '▼' : '▶'} {t('taskEdit.details')}
                    </Text>
                  </TouchableOpacity>
                </View>

                {showProjectMeta && (
                  <>
                    <View style={[styles.reviewContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                      <Text style={[styles.reviewLabel, { color: tc.text }]}>
                        {t('projects.areaLabel')}
                      </Text>
                      <TouchableOpacity
                        style={[styles.reviewButton, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
                        onPress={openAreaPicker}
                      >
                        <Text style={{ color: tc.text }}>
                          {selectedProject.areaId && areaById.has(selectedProject.areaId)
                            ? areaById.get(selectedProject.areaId)?.name
                            : t('projects.noArea')}
                        </Text>
                      </TouchableOpacity>
                    </View>

                    <View style={[styles.reviewContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                      <Text style={[styles.reviewLabel, { color: tc.text }]}>
                        {t('taskEdit.tagsLabel')}
                      </Text>
                      <TouchableOpacity
                        style={[styles.reviewButton, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
                        onPress={openTagPicker}
                      >
                        <Text style={{ color: tc.text }}>
                          {selectedProject.tagIds?.length ? selectedProject.tagIds.join(', ') : t('common.none')}
                        </Text>
                      </TouchableOpacity>
                    </View>

                    {/* Project Notes Section */}
                    <View style={[styles.notesContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                      <View style={styles.notesHeaderRow}>
                        <TouchableOpacity
                          style={styles.notesHeader}
                          onPress={() => {
                            setNotesExpanded(!notesExpanded);
                            if (notesExpanded) setShowNotesPreview(false);
                          }}
                        >
                          <Text style={[styles.notesTitle, { color: tc.text }]}>
                            {notesExpanded ? '▼' : '▶'} {t('project.notes')}
                          </Text>
                        </TouchableOpacity>
                        {notesExpanded && (
                          <TouchableOpacity
                            onPress={() => setShowNotesPreview((v) => !v)}
                            style={[styles.smallButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                          >
                            <Text style={[styles.smallButtonText, { color: tc.tint }]}>
                              {showNotesPreview ? t('markdown.edit') : t('markdown.preview')}
                            </Text>
                          </TouchableOpacity>
                        )}
                      </View>
                      {notesExpanded && (
                        showNotesPreview ? (
                          <View style={[styles.markdownPreview, { borderColor: tc.border, backgroundColor: tc.filterBg }]}>
                            <MarkdownText markdown={selectedProject.supportNotes || ''} tc={tc} />
                          </View>
                        ) : (
                          <TextInput
                            style={[styles.notesInput, { color: tc.text, backgroundColor: tc.inputBg, borderColor: tc.border }]}
                            multiline
                            placeholder={t('projects.notesPlaceholder')}
                            placeholderTextColor={tc.secondaryText}
                            value={selectedProject.supportNotes || ''}
                            onChangeText={(text) => setSelectedProject({ ...selectedProject, supportNotes: text })}
                            onEndEditing={() => updateProject(selectedProject.id, { supportNotes: selectedProject.supportNotes })}
                          />
                        )
                      )}
                    </View>

                    {/* Project Attachments */}
                    <View style={[styles.attachmentsContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                      <View style={styles.attachmentsHeader}>
                        <Text style={[styles.attachmentsTitle, { color: tc.text }]}>{t('attachments.title')}</Text>
                        <View style={styles.attachmentsActions}>
                          <TouchableOpacity
                            onPress={addProjectFileAttachment}
                            style={[styles.smallButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                          >
                            <Text style={[styles.smallButtonText, { color: tc.tint }]}>{t('attachments.addFile')}</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            onPress={() => {
                              setLinkModalVisible(true);
                              setLinkInput('');
                            }}
                            style={[styles.smallButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                          >
                            <Text style={[styles.smallButtonText, { color: tc.tint }]}>{t('attachments.addLink')}</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                      {((selectedProject.attachments || []) as Attachment[]).filter((a) => !a.deletedAt).length === 0 ? (
                        <Text style={[styles.helperText, { color: tc.secondaryText }]}>{t('common.none')}</Text>
                      ) : (
                        <View style={[styles.attachmentsList, { borderColor: tc.border, backgroundColor: tc.cardBg }]}>
                          {((selectedProject.attachments || []) as Attachment[])
                            .filter((a) => !a.deletedAt)
                            .map((attachment) => {
                              const isMissing = attachment.kind === 'file'
                                && (!attachment.uri || attachment.localStatus === 'missing');
                              const canDownload = isMissing && Boolean(attachment.cloudKey);
                              const isDownloading = attachment.localStatus === 'downloading';
                              return (
                                <View key={attachment.id} style={[styles.attachmentRow, { borderBottomColor: tc.border }]}>
                                  <TouchableOpacity
                                    style={styles.attachmentTitleWrap}
                                    onPress={() => openAttachment(attachment)}
                                    disabled={isDownloading}
                                  >
                                    <Text style={[styles.attachmentTitle, { color: tc.tint }]} numberOfLines={1}>
                                      {getAttachmentDisplayTitle(attachment)}
                                    </Text>
                                    <AttachmentProgressIndicator attachmentId={attachment.id} />
                                  </TouchableOpacity>
                                  {isDownloading ? (
                                    <Text style={[styles.attachmentStatus, { color: tc.secondaryText }]}>
                                      {t('common.loading')}
                                    </Text>
                                  ) : canDownload ? (
                                    <TouchableOpacity onPress={() => downloadAttachment(attachment)}>
                                      <Text style={[styles.attachmentDownload, { color: tc.tint }]}>
                                        {t('attachments.download')}
                                      </Text>
                                    </TouchableOpacity>
                                  ) : isMissing ? (
                                    <Text style={[styles.attachmentStatus, { color: tc.secondaryText }]}>
                                      {t('attachments.missing')}
                                    </Text>
                                  ) : null}
                                  <TouchableOpacity onPress={() => removeProjectAttachment(attachment.id)}>
                                    <Text style={[styles.attachmentRemove, { color: tc.secondaryText }]}>
                                      {t('attachments.remove')}
                                    </Text>
                                  </TouchableOpacity>
                                </View>
                              );
                            })}
                        </View>
                      )}
                    </View>

                    {/* Project Review Date (Tickler) */}
                    <View style={[styles.reviewContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                      <Text style={[styles.reviewLabel, { color: tc.text }]}>
                        {t('projects.reviewAt') || 'Review Date'}
                      </Text>
                      <TouchableOpacity
                        style={[styles.reviewButton, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
                        onPress={() => setShowReviewPicker(true)}
                      >
                        <Text style={{ color: tc.text }}>
                          {formatProjectReviewDate(selectedProject.reviewAt, t('common.notSet'))}
                        </Text>
                      </TouchableOpacity>
                      {!!selectedProject.reviewAt && (
                        <TouchableOpacity
                          style={styles.clearReviewBtn}
                          onPress={() => {
                            updateProject(selectedProject.id, { reviewAt: undefined });
                            setSelectedProject({ ...selectedProject, reviewAt: undefined });
                          }}
                        >
                          <Text style={[styles.clearReviewText, { color: tc.secondaryText }]}>
                            {t('common.clear')}
                          </Text>
                        </TouchableOpacity>
                      )}
                      {showReviewPicker && (
                        <DateTimePicker
                          value={new Date(selectedProject.reviewAt || Date.now())}
                          mode="date"
                          display="default"
                          onChange={(_, date) => {
                            setShowReviewPicker(false);
                            if (date) {
                              const iso = date.toISOString();
                              updateProject(selectedProject.id, { reviewAt: iso });
                              setSelectedProject({ ...selectedProject, reviewAt: iso });
                            }
                          }}
                        />
                      )}
                    </View>
                  </>
                )}

                <TaskList
                  statusFilter="all"
                  title={selectedProject.title}
                  showHeader={false}
                  projectId={selectedProject.id}
                  allowAdd={true}
                  staticList={true}
                  enableBulkActions={true}
                  showSort={false}
                />
                </ScrollView>
                </>
                  ) : null}
                </SafeAreaView>
      </Modal>

      <TaskEditModal
        visible={editingTask !== null}
        task={editingTask}
        onClose={() => setEditingTask(null)}
        onSave={(taskId, updates) => updateTask(taskId, updates)}
        defaultTab="view"
        onProjectNavigate={(projectId) => {
          if (!selectedProject || selectedProject.id !== projectId) {
            openProjectScreen(projectId);
          }
        }}
        onContextNavigate={openContextsScreen}
        onTagNavigate={openContextsScreen}
      />

      <ProjectLinkModal
        visible={linkModalVisible}
        presentationStyle={overlayModalPresentation}
        tc={tc}
        t={t}
        linkInput={linkInput}
        onChangeLinkInput={setLinkInput}
        onClose={() => {
          setLinkModalVisible(false);
          setLinkInput('');
        }}
        onSave={confirmAddProjectLink}
      />
      <ProjectImagePreviewModal
        visible={Boolean(imagePreviewAttachment)}
        attachment={imagePreviewAttachment}
        presentationStyle={overlayModalPresentation}
        tc={tc}
        t={t}
        onClose={() => setImagePreviewAttachment(null)}
      />
      <Modal
        visible={showAreaPicker}
        transparent
        animationType="fade"
        presentationStyle={overlayModalPresentation}
        onRequestClose={() => setShowAreaPicker(false)}
      >
        <Pressable style={styles.overlay} onPress={() => setShowAreaPicker(false)}>
          <Pressable style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border, maxHeight: pickerCardMaxHeight }]} onPress={(e) => e.stopPropagation()}>
            <Text style={[styles.linkModalTitle, { color: tc.text }]}>{t('projects.areaLabel')}</Text>
            <TouchableOpacity
              style={[styles.pickerRow, { borderColor: tc.border }]}
              onPress={() => {
                setShowAreaPicker(false);
                setNewAreaName('');
                setNewAreaColor(colors[0]);
                setShowAreaManager(true);
              }}
            >
              <Text style={[styles.pickerRowText, { color: tc.secondaryText }]}>+ {t('projects.areaLabel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.pickerRow, { borderColor: tc.border }]}
              onPress={() => {
                if (!selectedProject) return;
                updateProject(selectedProject.id, { areaId: undefined });
                setSelectedProject({ ...selectedProject, areaId: undefined });
                setShowAreaPicker(false);
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
                    setSelectedProject({ ...selectedProject, areaId: area.id });
                    setShowAreaPicker(false);
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
        onRequestClose={() => {
          setShowAreaManager(false);
          setExpandedAreaColorId(null);
        }}
      >
        <Pressable
          style={styles.overlay}
          onPress={() => {
            setShowAreaManager(false);
            setExpandedAreaColorId(null);
          }}
        >
          <Pressable style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border, maxHeight: pickerCardMaxHeight }]} onPress={(e) => e.stopPropagation()}>
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
                              onPress={() => setExpandedAreaColorId(isExpanded ? null : area.id)}
                              style={[styles.colorToggleButton, { borderColor: tc.border }]}
                            >
                              <View style={[styles.colorOption, { backgroundColor: area.color || tc.tint }]} />
                            </TouchableOpacity>
                            <TouchableOpacity
                              disabled={inUse}
                              onPress={() => {
                                if (inUse) {
                                  Alert.alert(t('common.notice') || 'Notice', t('projects.areaInUse') || 'Area has projects.');
                                  return;
                                }
                                deleteArea(area.id);
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
                                  updateArea(area.id, { color });
                                  setExpandedAreaColorId(null);
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
              onChangeText={setNewAreaName}
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
                  onPress={() => setNewAreaColor(color)}
                />
              ))}
            </View>
            <View style={styles.linkModalButtons}>
              <TouchableOpacity
                onPress={() => {
                  setShowAreaManager(false);
                  setExpandedAreaColorId(null);
                }}
                style={styles.linkModalButton}
              >
                <Text style={[styles.linkModalButtonText, { color: tc.secondaryText }]}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  const name = newAreaName.trim();
                  if (!name) return;
                  addArea(name, { color: newAreaColor });
                  setShowAreaManager(false);
                  setNewAreaName('');
                  setExpandedAreaColorId(null);
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
      <ProjectTagPickerModal
        visible={showTagPicker}
        presentationStyle={overlayModalPresentation}
        tc={tc}
        t={t}
        tagDraft={tagDraft}
        projectTagOptions={projectTagOptions}
        selectedTags={selectedProject?.tagIds || []}
        onChangeTagDraft={setTagDraft}
        onAddTag={() => {
          const nextTag = normalizeProjectTag(tagDraft);
          if (!nextTag) return;
          toggleProjectTag(nextTag);
          setTagDraft('');
        }}
        onClose={() => setShowTagPicker(false)}
        onToggleTag={toggleProjectTag}
      />
      </View>
    </GestureHandlerRootView>
  );
}
