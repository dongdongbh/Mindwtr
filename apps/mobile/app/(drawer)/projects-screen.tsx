import React, { useMemo, useState } from 'react';
import { View, Text, TextInput, SectionList, StyleSheet, TouchableOpacity, Modal, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Attachment, generateUUID, Project, useTaskStore } from '@mindwtr/core';
import DateTimePicker from '@react-native-community/datetimepicker';
import * as DocumentPicker from 'expo-document-picker';
import * as Linking from 'expo-linking';
import * as Sharing from 'expo-sharing';

import { TaskList } from '../../components/task-list';
import { useLanguage } from '../../contexts/language-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { MarkdownText } from '../../components/markdown-text';
import { ListSectionHeader, defaultListContentStyle } from '@/components/list-layout';

export default function ProjectsScreen() {
  const { projects, tasks, addProject, updateProject, deleteProject, toggleProjectFocus } = useTaskStore();
  const { t } = useLanguage();
  const tc = useThemeColors();
  const [newProjectTitle, setNewProjectTitle] = useState('');
  const [newProjectArea, setNewProjectArea] = useState('');
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [showNotesPreview, setShowNotesPreview] = useState(false);
  const [showReviewPicker, setShowReviewPicker] = useState(false);
  const [linkModalVisible, setLinkModalVisible] = useState(false);
  const [linkInput, setLinkInput] = useState('');

  const formatReviewDate = (dateStr?: string) => {
    if (!dateStr) return t('common.notSet');
    try {
      return new Date(dateStr).toLocaleDateString();
    } catch {
      return dateStr;
    }
  };

  const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];
  const [selectedColor, setSelectedColor] = useState(colors[0]);

  const groupedProjects = useMemo(() => {
    const visible = projects.filter(p => !p.deletedAt);
    const sorted = [...visible].sort((a, b) => {
      if (a.isFocused && !b.isFocused) return -1;
      if (!a.isFocused && b.isFocused) return 1;
      return a.title.localeCompare(b.title);
    });

    const noAreaLabel = t('common.none');
    const groups = new Map<string, Project[]>();
    for (const project of sorted) {
      const area = project.areaTitle?.trim() || noAreaLabel;
      if (!groups.has(area)) groups.set(area, []);
      groups.get(area)!.push(project);
    }

    return Array.from(groups.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([title, data]) => ({ title, data }));
  }, [projects, t]);

  const handleAddProject = () => {
    if (newProjectTitle.trim()) {
      addProject(newProjectTitle, selectedColor, {
        areaTitle: newProjectArea.trim() || undefined,
      });
      setNewProjectTitle('');
      setNewProjectArea('');
    }
  };

  const persistSelectedProjectEdits = (project: Project | null) => {
    if (!project) return;
    const original = projects.find((p) => p.id === project.id);
    if (!original) return;

    const nextTitle = project.title.trim();
    const nextArea = project.areaTitle?.trim() || undefined;
    const prevArea = original.areaTitle?.trim() || undefined;

    const updates: Partial<Project> = {};
    if (nextTitle && nextTitle !== original.title) updates.title = nextTitle;
    if (nextArea !== prevArea) updates.areaTitle = nextArea;

    if (Object.keys(updates).length > 0) {
      updateProject(project.id, updates);
    }
  };

  const handleCompleteSelectedProject = () => {
    if (!selectedProject) return;
    Alert.alert(
      t('projects.title'),
      t('projects.completeConfirm'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('projects.complete'),
          style: 'default',
          onPress: () => {
            updateProject(selectedProject.id, { status: 'completed' });
            setSelectedProject({ ...selectedProject, status: 'completed' });
          }
        }
      ]
    );
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

  const openAttachment = async (attachment: Attachment) => {
    if (attachment.kind === 'link') {
      Linking.openURL(attachment.uri).catch(console.error);
      return;
    }

    const available = await Sharing.isAvailableAsync().catch(() => false);
    if (available) {
      Sharing.shareAsync(attachment.uri).catch(console.error);
    } else {
      Linking.openURL(attachment.uri).catch(console.error);
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
    };
    const next = [...(selectedProject.attachments || []), attachment];
    updateProject(selectedProject.id, { attachments: next });
    setSelectedProject({ ...selectedProject, attachments: next });
  };

  const confirmAddProjectLink = () => {
    if (!selectedProject) return;
    const url = linkInput.trim();
    if (!url) return;
    const now = new Date().toISOString();
    const attachment: Attachment = {
      id: generateUUID(),
      kind: 'link',
      title: url,
      uri: url,
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

  return (
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
        <TextInput
          style={[styles.input, { borderColor: tc.border, backgroundColor: tc.inputBg, color: tc.text, marginTop: 8 }]}
          placeholder={t('projects.areaPlaceholder')}
          placeholderTextColor={tc.secondaryText}
          value={newProjectArea}
          onChangeText={setNewProjectArea}
          onSubmitEditing={handleAddProject}
          returnKeyType="done"
        />
        <View style={styles.colorPicker}>
          {colors.map((color) => (
            <TouchableOpacity
              key={color}
              style={[
                styles.colorOption,
                { backgroundColor: color },
                selectedColor === color && styles.colorOptionSelected,
              ]}
              onPress={() => setSelectedColor(color)}
            />
          ))}
        </View>
        <TouchableOpacity
          onPress={handleAddProject}
          style={[styles.addButton, !newProjectTitle.trim() && styles.addButtonDisabled]}
          disabled={!newProjectTitle.trim()}
        >
          <Text style={styles.addButtonText}>{t('projects.add')}</Text>
        </TouchableOpacity>
      </View>

      <SectionList
        sections={groupedProjects}
        keyExtractor={(item) => item.id}
        contentContainerStyle={defaultListContentStyle}
        renderSectionHeader={({ section }) => (
          <ListSectionHeader title={section.title} tc={tc} />
        )}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={[styles.emptyText, { color: tc.secondaryText }]}>{t('projects.empty')}</Text>
          </View>
        }
        renderItem={({ item }) => {
          const projTasks = tasks.filter(t => t.projectId === item.id && t.status !== 'done' && !t.deletedAt);
          const nextAction = projTasks.find((task) => task.status === 'next');
          const focusedCount = projects.filter(p => p.isFocused).length;
          const showFocusedWarning = item.isFocused && !nextAction && projTasks.length > 0;

          return (
            <View style={[
              styles.projectItem,
              { backgroundColor: tc.cardBg },
              item.isFocused && { borderColor: '#F59E0B', borderWidth: 1 }
            ]}>
              <TouchableOpacity
                onPress={() => toggleProjectFocus(item.id)}
                style={styles.focusButton}
                disabled={!item.isFocused && focusedCount >= 5}
              >
                <Text style={[
                  styles.focusIcon,
                  item.isFocused ? { opacity: 1 } : { opacity: focusedCount >= 5 ? 0.3 : 0.5 }
                ]}>
                  {item.isFocused ? '⭐' : '☆'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.projectTouchArea}
                onPress={() => {
                  setSelectedProject(item);
                  setNotesExpanded(false);
                  setShowNotesPreview(false);
                  setShowReviewPicker(false);
                  setLinkModalVisible(false);
                  setLinkInput('');
                }}
              >
                <View style={[styles.projectColor, { backgroundColor: item.color }]} />
                <View style={styles.projectContent}>
                  <Text style={[styles.projectTitle, { color: tc.text }]}>{item.title}</Text>
                  {nextAction ? (
                    <Text style={[styles.projectMeta, { color: tc.secondaryText }]} numberOfLines={1}>
                      ↳ {nextAction.title}
                    </Text>
                  ) : showFocusedWarning ? (
                    <Text style={[styles.projectMeta, { color: '#F59E0B' }]}>
                      ⚠️ No next action
                    </Text>
                  ) : (
                    <Text style={[styles.projectMeta, { color: tc.secondaryText }]}>
                      {item.status}
                    </Text>
                  )}
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  Alert.alert(
                    t('projects.title'),
                    t('projects.deleteConfirm'),
                    [
                      { text: t('common.cancel'), style: 'cancel' },
                      { text: t('common.delete'), style: 'destructive', onPress: () => deleteProject(item.id) }
                    ]
                  );
                }}
                style={styles.deleteButton}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Text style={styles.deleteText}>×</Text>
              </TouchableOpacity>
            </View>
          );
        }}
      />

      <Modal
        visible={!!selectedProject}
        animationType="slide"
        onRequestClose={() => {
          persistSelectedProjectEdits(selectedProject);
          setSelectedProject(null);
          setNotesExpanded(false);
          setShowNotesPreview(false);
          setShowReviewPicker(false);
          setLinkModalVisible(false);
          setLinkInput('');
        }}
      >
        <GestureHandlerRootView style={{ flex: 1 }}>
          <SafeAreaView style={{ flex: 1, backgroundColor: tc.bg }}>
            {selectedProject && (
              <>
                <View style={[styles.modalHeader, { borderBottomColor: tc.border, backgroundColor: tc.cardBg }]}>
                  <TextInput
                    style={[styles.modalTitle, { color: tc.text, marginLeft: 16, flex: 1 }]}
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

                <View style={[styles.statusActionsRow, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
                  {selectedProject.status === 'active' ? (
                    <>
                      <TouchableOpacity
                        onPress={handleCompleteSelectedProject}
                        style={[styles.statusButton, styles.completeButton]}
                      >
                        <Text style={[styles.statusButtonText, styles.completeText]}>
                          {t('projects.complete')}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={handleArchiveSelectedProject}
                        style={[styles.statusButton, styles.archiveButton]}
                      >
                        <Text style={[styles.statusButtonText, styles.archiveText]}>
                          {t('projects.archive')}
                        </Text>
                      </TouchableOpacity>
                    </>
                  ) : (
                    <TouchableOpacity
                      onPress={() => {
                        updateProject(selectedProject.id, { status: 'active' });
                        setSelectedProject({ ...selectedProject, status: 'active' });
                      }}
                      style={[styles.statusButton, styles.reactivateButton]}
                    >
                      <Text style={[styles.statusButtonText, styles.reactivateText]}>
                        {t('projects.reactivate')}
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>

                <View style={[styles.reviewContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                  <Text style={[styles.reviewLabel, { color: tc.text }]}>
                    {t('projects.color') || 'Color'}
                  </Text>
                  <View style={styles.colorPicker}>
                    {colors.map((color) => (
                      <TouchableOpacity
                        key={color}
                        style={[
                          styles.colorOption,
                          { backgroundColor: color, borderColor: color === selectedProject.color ? tc.text : 'transparent' },
                        ]}
                        onPress={() => {
                          if (selectedProject.color === color) return;
                          updateProject(selectedProject.id, { color });
                          setSelectedProject({ ...selectedProject, color });
                        }}
                      />
                    ))}
                  </View>
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
                        .map((attachment) => (
                          <View key={attachment.id} style={[styles.attachmentRow, { borderBottomColor: tc.border }]}>
                            <TouchableOpacity
                              style={styles.attachmentTitleWrap}
                              onPress={() => openAttachment(attachment)}
                            >
                              <Text style={[styles.attachmentTitle, { color: tc.tint }]} numberOfLines={1}>
                                {attachment.title}
                              </Text>
                            </TouchableOpacity>
                            <TouchableOpacity onPress={() => removeProjectAttachment(attachment.id)}>
                              <Text style={[styles.attachmentRemove, { color: tc.secondaryText }]}>
                                {t('attachments.remove')}
                              </Text>
                            </TouchableOpacity>
                          </View>
                        ))}
                    </View>
                  )}
                </View>

                {/* Project Area */}
                <View style={[styles.reviewContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                  <Text style={[styles.reviewLabel, { color: tc.text }]}>
                    {t('projects.areaLabel')}
                  </Text>
                  <TextInput
                    style={[styles.reviewButton, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                    placeholder={t('projects.areaPlaceholder')}
                    placeholderTextColor={tc.secondaryText}
                    value={selectedProject.areaTitle || ''}
                    onChangeText={(text) => setSelectedProject({ ...selectedProject, areaTitle: text })}
                    onSubmitEditing={(e) => {
                      const value = e.nativeEvent.text.trim();
                      updateProject(selectedProject.id, { areaTitle: value || undefined });
                      setSelectedProject({ ...selectedProject, areaTitle: value || undefined });
                    }}
                    onEndEditing={(e) => {
                      const value = e.nativeEvent.text.trim();
                      updateProject(selectedProject.id, { areaTitle: value || undefined });
                      setSelectedProject({ ...selectedProject, areaTitle: value || undefined });
                    }}
                    returnKeyType="done"
                    blurOnSubmit
                  />
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
                      {formatReviewDate(selectedProject.reviewAt)}
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

                <TaskList
                  statusFilter="all"
                  title={selectedProject.title}
                  showHeader={false}
                  projectId={selectedProject.id}
                  allowAdd={true}
                />
              </>
            )}
          </SafeAreaView>
        </GestureHandlerRootView>
      </Modal>

      <Modal
        visible={linkModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setLinkModalVisible(false)}
      >
        <View style={styles.overlay}>
          <View style={[styles.linkModalCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
            <Text style={[styles.linkModalTitle, { color: tc.text }]}>{t('attachments.addLink')}</Text>
            <TextInput
              value={linkInput}
              onChangeText={setLinkInput}
              placeholder={t('attachments.linkPlaceholder')}
              placeholderTextColor={tc.secondaryText}
              style={[styles.linkModalInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <View style={styles.linkModalButtons}>
              <TouchableOpacity
                onPress={() => {
                  setLinkModalVisible(false);
                  setLinkInput('');
                }}
                style={styles.linkModalButton}
              >
                <Text style={[styles.linkModalButtonText, { color: tc.secondaryText }]}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={confirmAddProjectLink}
                disabled={!linkInput.trim()}
                style={[styles.linkModalButton, !linkInput.trim() && styles.linkModalButtonDisabled]}
              >
                <Text style={[styles.linkModalButtonText, { color: tc.tint }]}>{t('common.save')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View >
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  inputContainer: {
    padding: 16,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e5e5',
  },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 16,
  },
  colorPicker: {
    flexDirection: 'row',
    gap: 8,
  },
  colorOption: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  colorOptionSelected: {
    borderColor: '#000',
  },
  addButton: {
    backgroundColor: '#007AFF',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  addButtonDisabled: {
    opacity: 0.5,
  },
  addButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  projectItem: {
    flexDirection: 'row',
    backgroundColor: '#f9f9f9',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    alignItems: 'center',
  },
  projectTouchArea: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  projectColor: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginRight: 12,
  },
  projectContent: {
    flex: 1,
  },
  projectTitle: {
    fontSize: 16,
    fontWeight: '500',
    marginBottom: 4,
  },
  projectMeta: {
    fontSize: 12,
    color: '#666',
  },
  deleteButton: {
    width: 32,
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
  deleteText: {
    fontSize: 28,
    color: '#999',
    fontWeight: '300',
  },
  emptyContainer: {
    padding: 48,
    alignItems: 'center',
  },
  emptyText: {
    color: '#999',
    fontSize: 16,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e5e5',
  },
  backButton: {
    padding: 8,
    width: 60,
  },
  backButtonText: {
    fontSize: 16,
    color: '#007AFF',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: 'bold',
  },
  sequentialBadge: {
    backgroundColor: '#DBEAFE',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  sequentialBadgeText: {
    fontSize: 10,
    color: '#1D4ED8',
    fontWeight: '500',
  },
  sequentialToggle: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#F3F4F6',
  },
  sequentialToggleActive: {
    backgroundColor: '#3B82F6',
  },
  sequentialToggleText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#6B7280',
  },
  sequentialToggleTextActive: {
    color: '#FFFFFF',
  },
  statusActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  statusButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    marginRight: 8,
  },
  statusButtonText: {
    fontSize: 12,
    fontWeight: '600',
  },
  completeButton: {
    backgroundColor: '#10B98120',
  },
  archiveButton: {
    backgroundColor: '#6B728020',
  },
  reactivateButton: {
    backgroundColor: '#3B82F620',
  },
  completeText: {
    color: '#10B981',
  },
  archiveText: {
    color: '#6B7280',
  },
  reactivateText: {
    color: '#3B82F6',
  },
  notesContainer: {
    borderBottomWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  notesHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  notesHeader: {
    paddingVertical: 8,
  },
  notesTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  notesInput: {
    marginTop: 8,
    borderRadius: 8,
    padding: 10,
    minHeight: 100,
    textAlignVertical: 'top',
    fontSize: 14,
    borderWidth: 1,
  },
  smallButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  smallButtonText: {
    fontSize: 12,
    fontWeight: '700',
  },
  markdownPreview: {
    marginTop: 8,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  attachmentsContainer: {
    borderBottomWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  attachmentsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  attachmentsTitle: {
    fontSize: 14,
    fontWeight: '700',
  },
  attachmentsActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  helperText: {
    marginTop: 8,
    fontSize: 13,
  },
  attachmentsList: {
    marginTop: 10,
    borderWidth: 1,
    borderRadius: 10,
    overflow: 'hidden',
  },
  attachmentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
  },
  attachmentTitleWrap: {
    flex: 1,
    paddingRight: 10,
  },
  attachmentTitle: {
    fontSize: 13,
    fontWeight: '600',
  },
  attachmentRemove: {
    fontSize: 12,
    fontWeight: '700',
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  linkModalCard: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
  },
  linkModalTitle: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 12,
  },
  linkModalInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  linkModalButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 14,
  },
  linkModalButton: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
  },
  linkModalButtonText: {
    fontSize: 14,
    fontWeight: '700',
  },
  linkModalButtonDisabled: {
    opacity: 0.5,
  },
  reviewContainer: {
    borderBottomWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  reviewLabel: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 6,
  },
  reviewButton: {
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  clearReviewBtn: {
    marginTop: 6,
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#e5e5e5',
  },
  clearReviewText: {
    fontSize: 12,
    fontWeight: '600',
  },
  focusButton: {
    padding: 8,
  },
  focusIcon: {
    fontSize: 18,
  },
});
