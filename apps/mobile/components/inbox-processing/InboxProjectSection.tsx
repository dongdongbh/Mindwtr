import React from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Folder } from 'lucide-react-native';

import { styles } from '../inbox-processing-modal.styles';
import type { ThemeColors } from '@/hooks/use-theme-colors';
import { useFilledButtonColors } from '@/hooks/use-filled-button-colors';

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
  convertToProject: boolean;
  projectTitleDraft: string;
  setProjectTitleDraft: (v: string) => void;
  nextActionDraft: string;
  setNextActionDraft: (v: string) => void;
  extraActionDrafts: string[];
  setExtraActionDrafts: (v: string[]) => void;
  filteredProjects: Project[];
  areaById: Map<string, Area>;
  hasExactProjectMatch: boolean;
  handleCreateProjectEarly: () => void;
  handleConvertToProject: () => void;
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
  convertToProject,
  projectTitleDraft,
  setProjectTitleDraft,
  nextActionDraft,
  setNextActionDraft,
  extraActionDrafts,
  setExtraActionDrafts,
  filteredProjects,
  areaById,
  hasExactProjectMatch,
  handleCreateProjectEarly,
  handleConvertToProject,
  selectProjectEarly,
}: Props) {
  const filledButton = useFilledButtonColors();
  if (!show) return null;

  const areaOptions = Array.from(areaById.values());

  const renderAreaPicker = () => {
    if (!showAreaField || selectedProjectId) return null;
    const noAreaSelected = !selectedAreaId;

    return (
      <View style={styles.projectFieldGroup}>
        <Text style={[styles.projectFieldLabel, { color: tc.secondaryText }]}>
          {t('taskEdit.areaLabel')}
        </Text>
        {currentArea && (
          <TouchableOpacity
            accessibilityRole="button"
            style={[
              styles.projectChip,
              { backgroundColor: tc.filterBg, borderWidth: 1, borderColor: tc.tint },
            ]}
            onPress={() => setSelectedAreaId(currentArea.id)}
            accessibilityState={{ selected: selectedAreaId === currentArea.id }}
          >
            <View style={[styles.projectDot, { backgroundColor: currentArea.color || tc.secondaryText }]} />
            <Text style={[styles.projectChipText, { color: tc.text }]}>✓ {currentArea.name}</Text>
          </TouchableOpacity>
        )}
        <View style={styles.projectListContainer}>
          <TouchableOpacity
            style={[
              styles.projectChip,
              noAreaSelected
                ? { backgroundColor: tc.filterBg, borderWidth: 1, borderColor: tc.tint }
                : { backgroundColor: tc.cardBg, borderWidth: 1, borderColor: tc.border },
            ]}
            onPress={() => setSelectedAreaId(null)}
            accessibilityState={{ selected: noAreaSelected }}
          >
            <Text style={[styles.projectChipText, { color: tc.text }]}>
              {noAreaSelected ? '✓ ' : ''}{t('projects.noArea')}
            </Text>
          </TouchableOpacity>
          {areaOptions.map((area) => {
            const isSelected = selectedAreaId === area.id;
            return (
              <TouchableOpacity
                key={area.id}
                style={[
                  styles.projectChip,
                  isSelected
                    ? { backgroundColor: tc.filterBg, borderWidth: 1, borderColor: tc.tint }
                    : { backgroundColor: tc.cardBg, borderWidth: 1, borderColor: tc.border },
                ]}
                onPress={() => setSelectedAreaId(area.id)}
                accessibilityState={{ selected: isSelected }}
              >
                <View style={[styles.projectDot, { backgroundColor: area.color || tc.secondaryText }]} />
                <Text style={[styles.projectChipText, { color: tc.text }]}>{area.name}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>
    );
  };

  const renderProjectPicker = () => {
    const noProjectSelected = !selectedProjectId;
    return (
      <>
      {showProjectField && currentProject && (
        <TouchableOpacity
          accessibilityRole="button"
          style={[
            styles.projectChip,
            { backgroundColor: tc.filterBg, borderWidth: 1, borderColor: tc.tint },
          ]}
          onPress={() => selectProjectEarly(currentProject.id)}
          accessibilityState={{ selected: selectedProjectId === currentProject.id }}
        >
          <Text style={[styles.projectChipText, { color: tc.text }]}>✓ {currentProject.title}</Text>
        </TouchableOpacity>
      )}
      {renderAreaPicker()}
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
                style={[styles.createProjectButton, { backgroundColor: filledButton.backgroundColor }]}
                onPress={handleCreateProjectEarly}
              >
                <Text style={[styles.createProjectButtonText, { color: filledButton.textColor ?? tc.onTint }]}>{t('projects.create')}</Text>
              </TouchableOpacity>
            )}
          </View>
          <View style={styles.projectListContainer}>
            <TouchableOpacity
              style={[
                styles.projectChip,
                noProjectSelected
                  ? { backgroundColor: tc.filterBg, borderWidth: 1, borderColor: tc.tint }
                  : { backgroundColor: tc.cardBg, borderWidth: 1, borderColor: tc.border },
              ]}
              onPress={() => selectProjectEarly(null)}
              accessibilityState={{ selected: noProjectSelected }}
            >
              <Text style={[styles.projectChipText, { color: tc.text }]}>
                {noProjectSelected ? '✓ ' : ''}{t('inbox.noProject')}
              </Text>
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
                      ? { backgroundColor: tc.filterBg, borderWidth: 1, borderColor: tc.tint }
                      : { backgroundColor: tc.cardBg, borderWidth: 1, borderColor: tc.border },
                  ]}
                  onPress={() => selectProjectEarly(project.id)}
                  accessibilityState={{ selected: isSelected }}
                >
                  <View style={[styles.projectDot, { backgroundColor: projectColor || tc.secondaryText }]} />
                  <Text style={[styles.projectChipText, { color: tc.text }]}>{project.title}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </>
      )}
      </>
    );
  };

  const renderProjectConversion = () => (
    <>
      {renderAreaPicker()}
      <View style={styles.projectConversionCard}>
        <View style={styles.projectFieldGroup}>
          <Text style={[styles.projectFieldLabel, { color: tc.secondaryText }]}>
            {t('projects.title')}
          </Text>
          <TextInput
            value={projectTitleDraft}
            onChangeText={setProjectTitleDraft}
            placeholder={t('projects.title')}
            placeholderTextColor={tc.secondaryText}
            accessibilityLabel={t('projects.title')}
            style={[styles.projectSearchInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
            returnKeyType="next"
          />
        </View>
        <View style={styles.projectFieldGroup}>
          <Text style={[styles.projectFieldLabel, { color: tc.secondaryText }]}>
            {t('process.nextAction')}
          </Text>
          {/* Enter chains into a fresh action row (desktop parity) and keeps
              the keyboard up — blurring here collapses the Android keyboard
              inset and makes the sheet visibly jump (#827 rc.3 feedback).
              The Create project button is the only way to finish the step. */}
          <TextInput
            value={nextActionDraft}
            onChangeText={setNextActionDraft}
            placeholder={t('taskEdit.titleLabel')}
            placeholderTextColor={tc.secondaryText}
            accessibilityLabel={t('process.nextAction')}
            style={[styles.projectSearchInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
            onSubmitEditing={() => {
              if (!nextActionDraft.trim()) return;
              setExtraActionDrafts([...extraActionDrafts, '']);
            }}
            blurOnSubmit={false}
            returnKeyType="next"
          />
          {extraActionDrafts.map((draft, index) => (
            <View key={index} style={styles.extraActionRow}>
              <TextInput
                autoFocus
                value={draft}
                onChangeText={(value) => setExtraActionDrafts(
                  extraActionDrafts.map((current, i) => (i === index ? value : current)),
                )}
                placeholder={t('taskEdit.titleLabel')}
                placeholderTextColor={tc.secondaryText}
                accessibilityLabel={t('process.nextAction')}
                style={[styles.projectSearchInput, styles.extraActionInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                onSubmitEditing={() => {
                  if (index !== extraActionDrafts.length - 1 || !draft.trim()) return;
                  setExtraActionDrafts([...extraActionDrafts, '']);
                }}
                blurOnSubmit={false}
                returnKeyType="next"
              />
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={t('process.removeAction')}
                onPress={() => setExtraActionDrafts(extraActionDrafts.filter((_, i) => i !== index))}
                style={styles.extraActionRemove}
              >
                <Text style={[styles.extraActionRemoveText, { color: tc.secondaryText }]}>✕</Text>
              </TouchableOpacity>
            </View>
          ))}
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => setExtraActionDrafts([...extraActionDrafts, ''])}
            style={styles.addActionButton}
          >
            <Text style={[styles.addActionText, { color: tc.tint }]}>+ {t('process.addAnotherAction')}</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity
          style={[styles.createProjectButton, styles.projectConversionSubmit, { backgroundColor: filledButton.backgroundColor }]}
          onPress={handleConvertToProject}
        >
          <Text style={[styles.createProjectButtonText, { color: filledButton.textColor ?? tc.onTint }]}>{t('process.createProject')}</Text>
        </TouchableOpacity>
      </View>
    </>
  );

  return (
    <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
      <View style={styles.stepQuestionRow}>
        <Folder size={20} color={tc.text} accessible={false} />
        <Text style={[styles.stepQuestion, styles.stepQuestionInline, { color: tc.text }]}>
          {/* The "more than one step?" question is its own step now; this
              section is the answer's field, whichever way it went. */}
          {showProjectField && convertToProject ? t('projects.title') : t('inbox.assignProjectQuestion')}
        </Text>
      </View>
      {showProjectField && convertToProject ? renderProjectConversion() : renderProjectPicker()}
    </View>
  );
}
