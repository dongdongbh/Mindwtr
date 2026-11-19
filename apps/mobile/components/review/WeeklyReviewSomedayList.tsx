import React, { useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text } from 'react-native';
import { ChevronDown, ChevronRight } from 'lucide-react-native';
import type { Area, Project, Task, WeeklyReviewBuckets } from '@mindwtr/core';
import type { ThemeColors } from '@/hooks/use-theme-colors';
import { AppPressable } from '../app-pressable';
import { SwipeableTaskItem, type TaskRowActions } from '../swipeable-task-item';
import { DeferredProjectRow } from '../views/deferred-projects-section';
import { styles as reviewStyles } from '../review-modal.styles';

type SomedaySection = WeeklyReviewBuckets['somedaySections'][number];
type SomedayRow =
    | { kind: 'section' | 'scheduled'; id: string; sectionId: string; text: string; expanded: boolean }
    | { kind: 'task'; id: string; task: Task }
    | { kind: 'project'; id: string; project: Project };

type Props = {
    sections: SomedaySection[];
    areaById: Map<string, Area>;
    onOpenProject: (projectId: string) => void;
    onActivateProject: (projectId: string) => void;
    actions: TaskRowActions;
    isDark: boolean;
    tc: ThemeColors;
    t: (key: string) => string;
    notDueYet: string;
};

function toggleSection(previous: Set<string>, sectionId: string) {
    const next = new Set(previous);
    if (!next.delete(sectionId)) next.add(sectionId);
    return next;
}

export function WeeklyReviewSomedayList({ sections, areaById, onOpenProject, onActivateProject, actions, isDark, tc, t, notDueYet }: Props) {
    const [collapsedSectionIds, setCollapsedSectionIds] = useState<Set<string>>(new Set());
    const [expandedScheduledIds, setExpandedScheduledIds] = useState<Set<string>>(new Set());
    const noSection = t('viewSections.noSection');
    const rows = useMemo(() => {
        const result: SomedayRow[] = [];
        const addItems = (tasks: Task[], projects: Project[]) => {
            projects.forEach((project) => result.push({ kind: 'project', id: `project:${project.id}`, project }));
            tasks.forEach((task) => result.push({ kind: 'task', id: `task:${task.id}`, task }));
        };
        for (const { id, title, tasks, projects } of sections) {
            const scheduledCount = tasks.scheduled.length + projects.scheduled.length;
            const count = scheduledCount + tasks.due.length + tasks.unscheduled.length + projects.due.length + projects.unscheduled.length;
            const expanded = !collapsedSectionIds.has(id);
            result.push({ kind: 'section', id: `section:${id}`, sectionId: id, text: `${title ?? noSection} (${count})`, expanded });
            if (!expanded) continue;
            addItems([...tasks.due, ...tasks.unscheduled], [...projects.due, ...projects.unscheduled]);
            if (scheduledCount > 0) {
                const scheduledExpanded = expandedScheduledIds.has(id);
                result.push({
                    kind: 'scheduled', id: `scheduled:${id}`, sectionId: id,
                    text: `${notDueYet} (${scheduledCount})`, expanded: scheduledExpanded,
                });
                if (scheduledExpanded) addItems(tasks.scheduled, projects.scheduled);
            }
        }
        return result;
    }, [collapsedSectionIds, expandedScheduledIds, noSection, notDueYet, sections]);
    return (
        <FlatList
            testID="review-someday-list"
            data={rows}
            renderItem={({ item: row }) => {
                if (row.kind === 'task') {
                    return <SwipeableTaskItem task={row.task} isDark={isDark} tc={tc} actions={actions} />;
                }
                if (row.kind === 'project') {
                    return (
                        <DeferredProjectRow
                            project={row.project}
                            areaById={areaById}
                            themeColors={tc}
                            t={t}
                            onActivateProject={onActivateProject}
                            onOpenProject={onOpenProject}
                        />
                    );
                }
                const scheduled = row.kind === 'scheduled';
                const Chevron = row.expanded ? ChevronDown : ChevronRight;
                return (
                    <AppPressable
                        accessibilityRole="button"
                        accessibilityLabel={row.text}
                        testID={`review-someday-${row.id}`}
                        accessibilityState={{ expanded: row.expanded }}
                        style={[localStyles.disclosure, !scheduled && { borderBottomColor: tc.border, borderBottomWidth: 1 }]}
                        onPress={() => {
                            const setSectionIds = scheduled ? setExpandedScheduledIds : setCollapsedSectionIds;
                            setSectionIds((previous) => toggleSection(previous, row.sectionId));
                        }}
                    >
                        <Chevron size={16} color={scheduled ? tc.secondaryText : tc.text} />
                        <Text style={[localStyles.disclosureText, { color: scheduled ? tc.secondaryText : tc.text }]}>
                            {row.text}
                        </Text>
                    </AppPressable>
                );
            }}
            keyExtractor={(row) => row.id}
            style={reviewStyles.taskList}
            contentContainerStyle={reviewStyles.taskListContent}
            initialNumToRender={12}
            maxToRenderPerBatch={12}
            windowSize={5}
            updateCellsBatchingPeriod={50}
            removeClippedSubviews={false}
            showsVerticalScrollIndicator={false}
        />
    );
}

const localStyles = StyleSheet.create({
    disclosure: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 },
    disclosureText: { fontSize: 14, fontWeight: '600', flexShrink: 1 },
});
