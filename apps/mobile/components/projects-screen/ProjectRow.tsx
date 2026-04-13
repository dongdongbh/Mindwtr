import React from 'react';
import { Alert, Text, TouchableOpacity, View } from 'react-native';
import { type Area, type Project, type Task } from '@mindwtr/core';
import { Trash2, Star, AlertTriangle } from 'lucide-react-native';

import { projectsScreenStyles as styles } from '@/components/projects-screen/projects-screen.styles';

type ThemeColors = {
    cardBg: string;
    secondaryText: string;
    text: string;
    tint: string;
};

type StatusPalette = Record<Project['status'], { text: string; bg: string; border: string }>;

type ProjectRowProps = {
    project: Project;
    tasks: Task[];
    areaById: Map<string, Area>;
    tc: ThemeColors;
    focusedCount: number;
    statusPalette: StatusPalette;
    t: (key: string) => string;
    onDeleteProject: (projectId: string) => void;
    onOpenProject: (project: Project) => void;
    onToggleProjectFocus: (projectId: string) => void;
};

function getStatusLabel(status: Project['status'], t: (key: string) => string) {
    if (status === 'active') return t('status.active');
    if (status === 'waiting') return t('status.waiting');
    if (status === 'someday') return t('status.someday');
    return t('status.archived');
}

export function ProjectRow({
    project,
    tasks,
    areaById,
    tc,
    focusedCount,
    statusPalette,
    t,
    onDeleteProject,
    onOpenProject,
    onToggleProjectFocus,
}: ProjectRowProps) {
    const projectTasks = tasks.filter((task) => (
        task.projectId === project.id
        && task.status !== 'done'
        && task.status !== 'reference'
        && !task.deletedAt
    ));
    const nextAction = projectTasks.find((task) => task.status === 'next');
    const showFocusedWarning = project.isFocused && !nextAction && projectTasks.length > 0;
    const projectColor = project.areaId ? areaById.get(project.areaId)?.color : undefined;

    return (
        <View
            style={[
                styles.projectItem,
                { backgroundColor: tc.cardBg },
                project.isFocused && { borderColor: '#F59E0B', borderWidth: 1 },
            ]}
        >
            <TouchableOpacity
                onPress={() => onToggleProjectFocus(project.id)}
                style={styles.focusButton}
                disabled={!project.isFocused && focusedCount >= 5}
                accessibilityRole="button"
                accessibilityLabel={project.isFocused ? 'Unfocus project' : 'Focus project'}
                accessibilityState={{ selected: project.isFocused, disabled: !project.isFocused && focusedCount >= 5 }}
                hitSlop={8}
            >
                <Star
                    size={22}
                    color={project.isFocused ? '#F59E0B' : tc.secondaryText}
                    fill={project.isFocused ? '#F59E0B' : 'transparent'}
                    strokeWidth={2}
                    style={{ opacity: project.isFocused ? 1 : focusedCount >= 5 ? 0.3 : 0.6 }}
                />
            </TouchableOpacity>
            <TouchableOpacity
                style={styles.projectTouchArea}
                onPress={() => onOpenProject(project)}
            >
                <View style={[styles.projectColor, { backgroundColor: projectColor || '#6B7280' }]} />
                <View style={styles.projectContent}>
                    <View style={styles.projectTitleRow}>
                        <Text style={[styles.projectTitle, { color: tc.text }]}>{project.title}</Text>
                        {project.tagIds?.length ? (
                            <View style={styles.projectTagDots}>
                                {project.tagIds.slice(0, 4).map((tag) => (
                                    <View
                                        key={tag}
                                        style={[styles.projectTagDot, { backgroundColor: tc.secondaryText }]}
                                    />
                                ))}
                            </View>
                        ) : null}
                    </View>
                    {nextAction ? (
                        <Text style={[styles.projectMeta, { color: tc.secondaryText }]} numberOfLines={1}>
                            ↳ {nextAction.title}
                        </Text>
                    ) : showFocusedWarning ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                            <AlertTriangle size={12} color="#F59E0B" strokeWidth={2.5} />
                            <Text style={[styles.projectMeta, { color: '#F59E0B' }]}>{t('projects.noNextAction')}</Text>
                        </View>
                    ) : (
                        <Text
                            style={[
                                styles.projectMeta,
                                { color: statusPalette[project.status]?.text ?? tc.secondaryText },
                            ]}
                        >
                            {getStatusLabel(project.status, t)}
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
                            {
                                text: t('common.delete'),
                                style: 'destructive',
                                onPress: () => onDeleteProject(project.id),
                            },
                        ],
                    );
                }}
                style={styles.deleteButton}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
                <Trash2 size={18} color={tc.secondaryText} />
            </TouchableOpacity>
        </View>
    );
}
