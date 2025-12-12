import React, { useMemo, useState } from 'react';
import { View, Text, TextInput, SectionList, StyleSheet, TouchableOpacity, Modal, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useTaskStore , Project } from '@mindwtr/core';
import DateTimePicker from '@react-native-community/datetimepicker';

import { TaskList } from '../../components/task-list';
import { useTheme } from '../../contexts/theme-context';
import { useLanguage } from '../../contexts/language-context';
import { Colors } from '@/constants/theme';

export default function ProjectsScreen() {
  const { projects, tasks, addProject, updateProject, deleteProject, toggleProjectFocus } = useTaskStore();
  const { isDark } = useTheme();
  const { t } = useLanguage();
  const [newProjectTitle, setNewProjectTitle] = useState('');
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [showReviewPicker, setShowReviewPicker] = useState(false);

  const formatReviewDate = (dateStr?: string) => {
    if (!dateStr) return t('common.notSet');
    try {
      return new Date(dateStr).toLocaleDateString();
    } catch {
      return dateStr;
    }
  };

  const tc = {
    bg: isDark ? Colors.dark.background : Colors.light.background,
    cardBg: isDark ? '#1F2937' : '#FFFFFF',
    text: isDark ? Colors.dark.text : Colors.light.text,
    secondaryText: isDark ? '#9CA3AF' : '#6B7280',
    border: isDark ? '#374151' : '#E5E7EB',
    inputBg: isDark ? '#374151' : '#f9f9f9',
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
      addProject(newProjectTitle, selectedColor);
      setNewProjectTitle('');
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

  return (
    <View style={[styles.container, { backgroundColor: tc.bg }]}>
      <View style={[styles.header, { borderBottomColor: tc.border }]}>
        <Text style={[styles.title, { color: tc.text }]}>{t('projects.title')}</Text>
        <Text style={[styles.count, { color: tc.secondaryText }]}>{projects.length} {t('projects.count')}</Text>
      </View>

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
        contentContainerStyle={styles.listContent}
        renderSectionHeader={({ section }) => (
          <Text style={[styles.sectionHeader, { color: tc.secondaryText }]}>
            {section.title}
          </Text>
        )}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={[styles.emptyText, { color: tc.secondaryText }]}>{t('projects.empty')}</Text>
          </View>
        }
        renderItem={({ item }) => {
          const projTasks = tasks.filter(t => t.projectId === item.id && t.status !== 'done' && t.status !== 'archived' && !t.deletedAt);
          // Optimize: Single pass to find todo (priority) or next (fallback)
          let nextAction = undefined;
          let nextCandidate = undefined;
          for (const t of projTasks) {
            if (t.status === 'todo') {
              nextAction = t;
              break;
            }
            if (!nextCandidate && t.status === 'next') {
              nextCandidate = t;
            }
          }
          nextAction = nextAction || nextCandidate;
          const focusedCount = projects.filter(p => p.isFocused).length;

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
                onPress={() => setSelectedProject(item)}
              >
                <View style={[styles.projectColor, { backgroundColor: item.color }]} />
                <View style={styles.projectContent}>
                  <Text style={[styles.projectTitle, { color: tc.text }]}>{item.title}</Text>
                  {nextAction ? (
                    <Text style={[styles.projectMeta, { color: tc.secondaryText }]} numberOfLines={1}>
                      ↳ {nextAction.title}
                    </Text>
                  ) : projTasks.length > 0 ? (
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
        onRequestClose={() => setSelectedProject(null)}
      >
        <GestureHandlerRootView style={{ flex: 1 }}>
          <SafeAreaView style={{ flex: 1, backgroundColor: tc.bg }}>
            {selectedProject && (
              <>
                <View style={[styles.modalHeader, { borderBottomColor: tc.border, backgroundColor: tc.cardBg }]}>
                  <Text style={[styles.modalTitle, { color: tc.text, marginLeft: 16 }]}>{selectedProject.title}</Text>
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
	
		                {/* Project Notes Section */}
	                <View style={[styles.notesContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
	                  <TouchableOpacity
	                    style={styles.notesHeader}
	                    onPress={() => setNotesExpanded(!notesExpanded)}
	                  >
	                    <Text style={[styles.notesTitle, { color: tc.text }]}>
	                      {notesExpanded ? '▼' : '▶'} {t('project.notes') || 'Project Notes'}
	                    </Text>
	                  </TouchableOpacity>
	                  {notesExpanded && (
	                    <TextInput
	                      style={[styles.notesInput, { color: tc.text, backgroundColor: tc.inputBg }]}
	                      multiline
	                      placeholder="Add project notes..."
	                      placeholderTextColor={tc.secondaryText}
	                      defaultValue={selectedProject.supportNotes}
	                      onEndEditing={(e) => {
	                        if (selectedProject) {
	                          updateProject(selectedProject.id, { supportNotes: e.nativeEvent.text })
	                        }
	                      }}
	                    />
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
		                    defaultValue={selectedProject.areaTitle || ''}
		                    onEndEditing={(e) => {
		                      const value = e.nativeEvent.text.trim();
		                      updateProject(selectedProject.id, { areaTitle: value || undefined });
		                      setSelectedProject({ ...selectedProject, areaTitle: value || undefined });
		                    }}
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
                  projectId={selectedProject.id}
                  allowAdd={true}
                />
              </>
            )}
          </SafeAreaView>
        </GestureHandlerRootView>
      </Modal>
    </View >
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e5e5',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
  },
  count: {
    fontSize: 14,
    color: '#666',
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
  listContent: {
    padding: 16,
  },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    marginBottom: 6,
    marginTop: 10,
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
