import React from 'react';
import { Image, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { CheckSquare, Square } from 'lucide-react-native';
import { getAttachmentDisplayTitle } from '@mindwtr/core';
import type {
  Attachment,
  Area,
  Project,
  Section,
  RecurrenceRule,
  RecurrenceStrategy,
  Task,
  TimeEstimate,
} from '@mindwtr/core';
import type { ThemeColors } from '@/hooks/use-theme-colors';
import { MarkdownText } from '../markdown-text';
import { AttachmentProgressIndicator } from '../AttachmentProgressIndicator';

type TaskEditViewTabProps = {
  t: (key: string) => string;
  tc: ThemeColors;
  styles: Record<string, any>;
  mergedTask: Partial<Task>;
  projects: Project[];
  sections: Section[];
  areas: Area[];
  prioritiesEnabled: boolean;
  timeEstimatesEnabled: boolean;
  formatTimeEstimateLabel: (value: TimeEstimate) => string;
  formatDate: (value: string) => string;
  formatDueDate: (value: string) => string;
  getRecurrenceRuleValue: (recurrence: Task['recurrence']) => RecurrenceRule | '';
  getRecurrenceStrategyValue: (recurrence: Task['recurrence']) => RecurrenceStrategy;
  applyChecklistUpdate: (checklist: NonNullable<Task['checklist']>) => void;
  visibleAttachments: Attachment[];
  openAttachment: (attachment: Attachment) => void;
  isImageAttachment: (attachment: Attachment) => boolean;
  textDirectionStyle: Record<string, any>;
  resolvedDirection: 'ltr' | 'rtl';
  nestedScrollEnabled?: boolean;
  onProjectPress?: (projectId: string) => void;
  onContextPress?: (context: string) => void;
  onTagPress?: (tag: string) => void;
};

export function TaskEditViewTab({
  t,
  tc,
  styles,
  mergedTask,
  projects,
  sections,
  areas,
  prioritiesEnabled,
  timeEstimatesEnabled,
  formatTimeEstimateLabel,
  formatDate,
  formatDueDate,
  getRecurrenceRuleValue,
  getRecurrenceStrategyValue,
  applyChecklistUpdate,
  visibleAttachments,
  openAttachment,
  isImageAttachment,
  textDirectionStyle,
  resolvedDirection,
  nestedScrollEnabled,
  onProjectPress,
  onContextPress,
  onTagPress,
}: TaskEditViewTabProps) {
  const renderViewRow = (label: string, value?: string, onPress?: () => void, accessibilityLabel?: string) => {
    if (value === undefined || value === null || value === '') return null;
    const content = (
      <>
        <Text style={[styles.viewLabel, { color: tc.secondaryText }]}>{label}</Text>
        <Text style={[styles.viewValue, { color: tc.text }]}>{value}</Text>
      </>
    );
    if (!onPress) {
      return (
        <View style={[styles.viewRow, { backgroundColor: tc.inputBg, borderColor: tc.border }]}>
          {content}
        </View>
      );
    }
    return (
      <TouchableOpacity
        style={[styles.viewRow, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? `${label}: ${value}`}
      >
        {content}
      </TouchableOpacity>
    );
  };

  const renderViewPills = (items: string[] | undefined, onPress?: (item: string) => void, type?: 'context' | 'tag') => {
    if (!items || items.length === 0) return null;
    return (
      <View style={styles.viewPillRow}>
        {items.map((item) => {
          if (!onPress) {
            return (
              <View key={item} style={[styles.viewPill, { borderColor: tc.border, backgroundColor: tc.inputBg }]}>
                <Text style={[styles.viewPillText, { color: tc.text }]}>{item}</Text>
              </View>
            );
          }
          return (
            <TouchableOpacity
              key={item}
              style={[styles.viewPill, { borderColor: tc.border, backgroundColor: tc.inputBg }]}
              onPress={() => onPress(item)}
              accessibilityRole="button"
              accessibilityLabel={`Open ${type === 'tag' ? 'tag' : 'context'} ${item}`}
            >
              <Text style={[styles.viewPillText, { color: tc.text }]}>{item}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    );
  };

  const project = projects.find((p) => p.id === mergedTask.projectId);
  const section = sections.find((item) => item.id === mergedTask.sectionId);
  const description = String(mergedTask.description || '').trim();
  const area = areas.find((a) => a.id === mergedTask.areaId);
  const checklist = mergedTask.checklist || [];

  const statusLabel = mergedTask.status ? (t(`status.${mergedTask.status}`) || mergedTask.status) : undefined;
  const isReference = mergedTask.status === 'reference';
  const priorityLabel = mergedTask.priority ? (t(`priority.${mergedTask.priority}`) || mergedTask.priority) : undefined;
  const energyLevelLabel = mergedTask.energyLevel
    ? (t(`energyLevel.${mergedTask.energyLevel}`) || mergedTask.energyLevel)
    : undefined;
  const timeEstimateLabel = mergedTask.timeEstimate
    ? (formatTimeEstimateLabel(mergedTask.timeEstimate as TimeEstimate) || String(mergedTask.timeEstimate))
    : undefined;
  const recurrenceRule = getRecurrenceRuleValue(mergedTask.recurrence);
  const recurrenceStrategy = getRecurrenceStrategyValue(mergedTask.recurrence);
  const recurrenceLabel = recurrenceRule
    ? `${t(`recurrence.${recurrenceRule}`) || recurrenceRule}${recurrenceStrategy === 'fluid' ? ` · ${t('recurrence.afterCompletionShort')}` : ''}`
    : undefined;

  return (
    <ScrollView
      style={styles.content}
      contentContainerStyle={styles.contentContainer}
      keyboardShouldPersistTaps="handled"
      nestedScrollEnabled={nestedScrollEnabled}
    >
      {renderViewRow(t('taskEdit.statusLabel'), statusLabel)}
      {!isReference && prioritiesEnabled ? renderViewRow(t('taskEdit.priorityLabel'), priorityLabel) : null}
      {!isReference ? renderViewRow(t('taskEdit.energyLevel'), energyLevelLabel) : null}
      {renderViewRow(t('taskEdit.assignedTo'), mergedTask.assignedTo)}
      {renderViewRow(
        t('taskEdit.projectLabel'),
        project?.title,
        project?.id && onProjectPress ? () => onProjectPress(project.id) : undefined,
        project?.title ? `Open project ${project.title}` : undefined
      )}
      {project?.id ? renderViewRow(t('taskEdit.sectionLabel'), section?.title) : null}
      {!project?.id ? renderViewRow(t('taskEdit.areaLabel'), area?.name) : null}
      {!isReference ? renderViewRow(t('taskEdit.startDateLabel'), mergedTask.startTime ? formatDate(mergedTask.startTime) : undefined) : null}
      {!isReference ? renderViewRow(t('taskEdit.dueDateLabel'), mergedTask.dueDate ? formatDueDate(mergedTask.dueDate) : undefined) : null}
      {!isReference ? renderViewRow(t('taskEdit.reviewDateLabel'), mergedTask.reviewAt ? formatDate(mergedTask.reviewAt) : undefined) : null}
      {!isReference && timeEstimatesEnabled ? renderViewRow(t('taskEdit.timeEstimateLabel'), timeEstimateLabel) : null}
      {mergedTask.contexts?.length ? (
        <View style={styles.viewSection}>
          <Text style={[styles.viewLabel, { color: tc.secondaryText }]}>{t('taskEdit.contextsLabel')}</Text>
          {renderViewPills(mergedTask.contexts, onContextPress, 'context')}
        </View>
      ) : null}
      {mergedTask.tags?.length ? (
        <View style={styles.viewSection}>
          <Text style={[styles.viewLabel, { color: tc.secondaryText }]}>{t('taskEdit.tagsLabel')}</Text>
          {renderViewPills(mergedTask.tags, onTagPress, 'tag')}
        </View>
      ) : null}
      {mergedTask.location ? renderViewRow(t('taskEdit.locationLabel'), mergedTask.location) : null}
      {!isReference && recurrenceLabel ? renderViewRow(t('taskEdit.recurrenceLabel'), recurrenceLabel) : null}
      {description ? (
        <View style={styles.viewSection}>
          <Text style={[styles.viewLabel, { color: tc.secondaryText }]}>{t('taskEdit.descriptionLabel')}</Text>
          <View style={[styles.viewCard, { borderColor: tc.border, backgroundColor: tc.inputBg }]}
          >
            <MarkdownText markdown={description} tc={tc} direction={resolvedDirection} />
          </View>
        </View>
      ) : null}
      {!isReference && checklist.length ? (
        <View style={styles.viewSection}>
          <Text style={[styles.viewLabel, { color: tc.secondaryText }]}>{t('taskEdit.checklist')}</Text>
          <View style={styles.viewChecklist}>
            {checklist.map((item) => (
              <TouchableOpacity
                key={item.id}
                style={styles.viewChecklistItem}
                onPress={() => {
                  const nextChecklist = checklist.map((entry) =>
                    entry.id === item.id ? { ...entry, isCompleted: !entry.isCompleted } : entry
                  );
                  applyChecklistUpdate(nextChecklist);
                }}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: item.isCompleted }}
                accessibilityLabel={item.title}
              >
                {item.isCompleted ? (
                  <CheckSquare size={18} color={tc.tint} strokeWidth={2} />
                ) : (
                  <Square size={18} color={tc.secondaryText} strokeWidth={2} />
                )}
                <Text style={[styles.viewChecklistText, textDirectionStyle, { color: tc.text }]}>{item.title}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      ) : null}
      {visibleAttachments.length ? (
        <View style={styles.viewSection}>
          <Text style={[styles.viewLabel, { color: tc.secondaryText }]}>{t('attachments.title')}</Text>
          <View style={styles.viewAttachmentGrid}>
            {visibleAttachments.map((attachment) => (
              <TouchableOpacity
                key={attachment.id}
                style={[styles.viewAttachmentCard, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                onPress={() => openAttachment(attachment)}
                disabled={attachment.localStatus === 'downloading'}
              >
                {(() => {
                  const isMissing = attachment.kind === 'file'
                    && (!attachment.uri || attachment.localStatus === 'missing');
                  const canDownload = isMissing && Boolean(attachment.cloudKey);
                  const isDownloading = attachment.localStatus === 'downloading';
                  if (isImageAttachment(attachment) && !isMissing) {
                    return <Image source={{ uri: attachment.uri }} style={styles.viewAttachmentImage} />;
                  }
                  return (
                    <View>
                      <Text style={[styles.viewAttachmentText, { color: tc.text }]} numberOfLines={2}>
                        {getAttachmentDisplayTitle(attachment)}
                      </Text>
                      {isDownloading ? (
                        <Text style={[styles.viewAttachmentSubtext, { color: tc.secondaryText }]}>
                          {t('common.loading')}
                        </Text>
                      ) : canDownload ? (
                        <Text style={[styles.viewAttachmentSubtext, { color: tc.secondaryText }]}>
                          {t('attachments.download')}
                        </Text>
                      ) : isMissing ? (
                        <Text style={[styles.viewAttachmentSubtext, { color: tc.secondaryText }]}>
                          {t('attachments.missing')}
                        </Text>
                      ) : null}
                      <AttachmentProgressIndicator attachmentId={attachment.id} />
                    </View>
                  );
                })()}
              </TouchableOpacity>
            ))}
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}
