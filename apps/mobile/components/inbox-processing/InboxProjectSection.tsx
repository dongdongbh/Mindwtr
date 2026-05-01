import React from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';

import { styles } from '../inbox-processing-modal.styles';
import type { ThemeColors } from '@/hooks/use-theme-colors';

type Area = { id: string; name: string; color?: string };
type Project = { id: string; title: string; areaId?: string };

type Props = {
  t: (key: string) => string;
  tc: ThemeColors;
  show: boolean;
  showProjectField: boolean;
  showAreaField: boolean;
  currentProject?: Project | null;
  currentArea?: Area | null;
  selectedProjectId?: string | null;
  selectedAreaId?: string | null;
  setSelectedAreaId: (v: string | null) => void;
  projectSearch: string;
  setProjectSearch: (v: string) => void;
  filteredProjects: Project[];
  areaById: Map<string, Area>;
  hasExactProjectMatch: boolean;
  handleCreateProjectEarly: () => void;
  selectProjectEarly: (id: string | null) => void;
};

export function InboxProjectSection({
  t,
  tc,
  show,
  showProjectField,
  showAreaField,
  currentProject,
  currentArea,
  selectedProjectId,
  selectedAreaId,
  setSelectedAreaId,
  projectSearch,
  setProjectSearch,
  filteredProjects,
  areaById,
  hasExactProjectMatch,
  handleCreateProjectEarly,
  selectProjectEarly,
}: Props) {
  if (!show) return null;

  const areaOptions = Array.from(areaById.values());

  return (
    <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
      <Text style={[styles.stepQuestion, { color: tc.text }]}>
        📁 {t('inbox.assignProjectQuestion')}
      </Text>
      {showProjectField && currentProject && (
        <TouchableOpacity
          style={[styles.projectChip, { backgroundColor: tc.tint }]}
          onPress={() => selectProjectEarly(currentProject.id)}
        >
          <Text style={styles.projectChipText}>✓ {currentProject.title}</Text>
        </TouchableOpacity>
      )}
      {showAreaField && !selectedProjectId && currentArea && (
        <TouchableOpacity
          style={[styles.projectChip, { backgroundColor: currentArea.color || tc.tint }]}
          onPress={() => setSelectedAreaId(currentArea.id)}
        >
          <Text style={styles.projectChipText}>✓ {currentArea.name}</Text>
        </TouchableOpacity>
      )}
      {showAreaField && !selectedProjectId && (
        <View style={styles.projectListContainer}>
          <TouchableOpacity
            style={[styles.projectChip, { backgroundColor: tc.filterBg, borderWidth: 1, borderColor: tc.border }]}
            onPress={() => setSelectedAreaId(null)}
          >
            <Text style={[styles.projectChipText, { color: tc.text }]}>✓ {t('projects.noArea')}</Text>
          </TouchableOpacity>
          {areaOptions.map((area) => {
            const isSelected = selectedAreaId === area.id;
            return (
              <TouchableOpacity
                key={area.id}
                style={[
                  styles.projectChip,
                  isSelected
                    ? { backgroundColor: '#3B82F620', borderWidth: 1, borderColor: tc.tint }
                    : { backgroundColor: tc.cardBg, borderWidth: 1, borderColor: tc.border },
                ]}
                onPress={() => setSelectedAreaId(area.id)}
              >
                <View style={[styles.projectDot, { backgroundColor: area.color || '#6B7280' }]} />
                <Text style={[styles.projectChipText, { color: tc.text }]}>{area.name}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}
      {showProjectField && (
        <>
          <View style={styles.projectSearchRow}>
            <TextInput
              value={projectSearch}
              onChangeText={setProjectSearch}
              placeholder={t('projects.addPlaceholder')}
              placeholderTextColor={tc.secondaryText}
              style={[styles.projectSearchInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
              onSubmitEditing={handleCreateProjectEarly}
              returnKeyType="done"
            />
            {!hasExactProjectMatch && projectSearch.trim() && (
              <TouchableOpacity
                style={[styles.createProjectButton, { backgroundColor: tc.tint }]}
                onPress={handleCreateProjectEarly}
              >
                <Text style={styles.createProjectButtonText}>{t('projects.create')}</Text>
              </TouchableOpacity>
            )}
          </View>
          <View style={styles.projectListContainer}>
            <TouchableOpacity
              style={[styles.projectChip, { backgroundColor: '#10B981' }]}
              onPress={() => selectProjectEarly(null)}
            >
              <Text style={styles.projectChipText}>✓ {t('inbox.noProject')}</Text>
            </TouchableOpacity>
            {filteredProjects.map((project) => {
              const projectColor = project.areaId ? areaById.get(project.areaId)?.color : undefined;
              const isSelected = selectedProjectId === project.id;
              return (
                <TouchableOpacity
                  key={project.id}
                  style={[
                    styles.projectChip,
                    isSelected
                      ? { backgroundColor: '#3B82F620', borderWidth: 1, borderColor: tc.tint }
                      : { backgroundColor: tc.cardBg, borderWidth: 1, borderColor: tc.border },
                  ]}
                  onPress={() => selectProjectEarly(project.id)}
                >
                  <View style={[styles.projectDot, { backgroundColor: projectColor || '#6B7280' }]} />
                  <Text style={[styles.projectChipText, { color: tc.text }]}>{project.title}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </>
      )}
    </View>
  );
}
