import { getProjectAccentColor } from '@mindwtr/core';
import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { ChevronDown, ChevronRight, Folder } from 'lucide-react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { tFallback } from '@mindwtr/core';
import type { Area, Project } from '@mindwtr/core';

import type { ThemeColors } from '@/hooks/use-theme-colors';

export interface DeferredProjectsSectionProps {
  projects: Project[];
  areaById: Map<string, Area>;
  themeColors: ThemeColors;
  t: (key: string) => string;
  onActivateProject: (projectId: string) => void;
  onOpenProject: (projectId: string) => void;
}

/** Renders nothing when there is nothing deferred, so callers can pass it straight to a list header. */
export function DeferredProjectsSection({
  projects,
  areaById,
  themeColors: tc,
  t,
  onActivateProject,
  onOpenProject,
}: DeferredProjectsSectionProps) {
  const [expanded, setExpanded] = useState(true);
  if (projects.length === 0) return null;

  return (
    <View style={[styles.projectSection, !expanded && styles.collapsedProjectSection, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`${tFallback(t, 'projects.title', 'Projects')} (${projects.length})`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={styles.sectionHeader}
      >
        {expanded ? <ChevronDown size={18} color={tc.secondaryText} /> : <ChevronRight size={18} color={tc.secondaryText} />}
        <Text style={[styles.sectionLabel, { color: tc.secondaryText }]}>
          {tFallback(t, 'projects.title', 'Projects')} ({projects.length})
        </Text>
      </TouchableOpacity>
      {expanded && projects.map((project) => (
        <DeferredProjectRow
          key={project.id}
          project={project}
          areaById={areaById}
          themeColors={tc}
          t={t}
          onActivateProject={onActivateProject}
          onOpenProject={onOpenProject}
        />
      ))}
    </View>
  );
}

export interface DeferredProjectRowProps {
  project: Project;
  areaById: Map<string, Area>;
  themeColors: ThemeColors;
  t: (key: string) => string;
  onActivateProject: (projectId: string) => void;
  onOpenProject: (projectId: string) => void;
  /** Long press (and the accessibility action) offers "Move to section…" when given. */
  onMoveToSection?: (project: Project) => void;
}

/** One parked project: tap opens it, swipe right reactivates it. */
export function DeferredProjectRow({
  project,
  areaById,
  themeColors: tc,
  t,
  onActivateProject,
  onOpenProject,
  onMoveToSection,
}: DeferredProjectRowProps) {
  const projectArea = project.areaId ? areaById.get(project.areaId) : undefined;
  const moveLabel = tFallback(t, 'viewSections.moveToSection', 'Move to section…');
  return (
    <Swipeable
      renderLeftActions={() => (
        <View style={[styles.activateAction, { backgroundColor: tc.tint, borderColor: tc.border }]}>
          <Text style={[styles.activateActionText, { color: tc.onTint }]}>{t('projects.reactivate')}</Text>
        </View>
      )}
      onSwipeableLeftOpen={() => onActivateProject(project.id)}
    >
      <TouchableOpacity
        style={[styles.projectRow, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
        onPress={() => onOpenProject(project.id)}
        onLongPress={onMoveToSection ? () => onMoveToSection(project) : undefined}
        accessibilityActions={onMoveToSection ? [{ name: 'moveToSection', label: moveLabel }] : undefined}
        onAccessibilityAction={onMoveToSection
          ? (event) => { if (event.nativeEvent.actionName === 'moveToSection') onMoveToSection(project); }
          : undefined}
      >
        <Folder size={18} color={getProjectAccentColor(project, areaById) || tc.secondaryText} />
        <View style={styles.projectText}>
          <Text style={[styles.projectTitle, { color: tc.text }]} numberOfLines={1}>
            {project.title}
          </Text>
          {projectArea && (
            <Text style={[styles.projectMeta, { color: tc.secondaryText }]} numberOfLines={1}>
              {projectArea.name}
            </Text>
          )}
        </View>
      </TouchableOpacity>
    </Swipeable>
  );
}

const styles = StyleSheet.create({
  projectSection: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
    gap: 8,
  },
  sectionLabel: {
    flexShrink: 1,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  collapsedProjectSection: {
    paddingVertical: 0,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    gap: 8,
  },
  projectRow: {
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  projectText: {
    flex: 1,
  },
  projectTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  projectMeta: {
    fontSize: 12,
    marginTop: 2,
  },
  activateAction: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: 1,
  },
  activateActionText: {
    fontWeight: '600',
  },
});
