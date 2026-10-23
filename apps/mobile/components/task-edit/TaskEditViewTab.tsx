import React from 'react';
import { Image, Platform, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { CheckSquare, Square } from 'lucide-react-native';
import {
  applyTaskChecklistEdit,
  buildTaskViewModel,
  generateUUID,
  useTaskStore,
  type TaskViewRow,
} from '@mindwtr/core';
import type {
  Attachment,
  Area,
  Project,
  Section,
  RecurrenceRule,
  RecurrenceStrategy,
  TaskStatus,
  Task,
  TimeEstimate,
} from '@mindwtr/core';
import type { ThemeColors } from '@/hooks/use-theme-colors';
import { MarkdownInlineText, MarkdownText } from '../markdown-text';
import { AttachmentProgressIndicator } from '../AttachmentProgressIndicator';
import { TaskStatusBadge } from '../task-status-badge';
import { usePreviewChecklistKeyboard } from './use-preview-checklist-keyboard';

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
  /** Holds add-item text the user has typed but not submitted, so the Save
   *  button (which lives outside this tab) can fold it into the saved
   *  checklist instead of relying on the input blurring first. */
  pendingChecklistDraftRef?: React.MutableRefObject<string>;
  visibleAttachments: Attachment[];
  openAttachment: (attachment: Attachment) => void;
  isImageAttachment: (attachment: Attachment) => boolean;
  textDirectionStyle: Record<string, any>;
  resolvedDirection: 'ltr' | 'rtl';
  nestedScrollEnabled?: boolean;
  onProjectPress?: (projectId: string) => void;
  onContextPress?: (context: string) => void;
  onTagPress?: (tag: string) => void;
  onBackdatedComplete?: () => void;
  onStatusUpdate?: (status: TaskStatus) => void;
  showStatusField?: boolean;
  readOnly?: boolean;
};

function TaskEditViewTabComponent({
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
  applyChecklistUpdate,
  pendingChecklistDraftRef,
  visibleAttachments,
  openAttachment,
  isImageAttachment,
  textDirectionStyle,
  resolvedDirection,
  nestedScrollEnabled,
  onProjectPress,
  onContextPress,
  onTagPress,
  onBackdatedComplete,
  onStatusUpdate,
  showStatusField = true,
  readOnly = false,
}: TaskEditViewTabProps) {
  const [checklistDraft, setChecklistDraft] = React.useState('');
  const updateChecklistDraft = React.useCallback((text: string) => {
    setChecklistDraft(text);
    if (pendingChecklistDraftRef) pendingChecklistDraftRef.current = text;
  }, [pendingChecklistDraftRef]);
  const checklistDraftRef = React.useRef<TextInput>(null);
  const previewScrollRef = React.useRef<ScrollView>(null);
  const checklistKeyboard = usePreviewChecklistKeyboard(previewScrollRef, checklistDraftRef);

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

  const renderViewPills = (items: { value: string; accessibilityLabel: string }[], onPress?: (item: string) => void) => (
    <View style={styles.viewPillRow}>
      {items.map(({ value: item, accessibilityLabel }) => {
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
            accessibilityLabel={accessibilityLabel}
          >
            <Text style={[styles.viewPillText, { color: tc.text }]}>{item}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );

  const reminderSettings = useTaskStore((state) => state.settings);
  const rows = buildTaskViewModel({
    task: mergedTask,
    settings: reminderSettings,
    projects,
    sections,
    areas,
    attachments: visibleAttachments,
    prioritiesEnabled,
    timeEstimatesEnabled,
    showStatusField,
    readOnly,
    t,
    formatDate,
    formatDueDate,
    formatTimeEstimateLabel,
    isImageAttachment,
  });
  const checklist = mergedTask.checklist || [];
  const editChecklist = (edit: Parameters<typeof applyTaskChecklistEdit>[1]) => {
    const result = applyTaskChecklistEdit(checklist, edit, { newId: generateUUID });
    if (result) applyChecklistUpdate(result.checklist);
    return result;
  };

  const renderRow = (row: TaskViewRow) => {
    switch (row.type) {
      case 'title':
        return (
          <View key="title" style={[styles.viewRow, { backgroundColor: tc.inputBg, borderColor: tc.border }]}>
            <Text style={[styles.viewLabel, { color: tc.secondaryText }]}>{row.label}</Text>
            <Text style={[styles.viewTitleValue, { color: tc.text }]}>
              {row.value}
            </Text>
          </View>
        );
      case 'status':
        return (
          <View key="status" style={[styles.viewRow, { backgroundColor: tc.inputBg, borderColor: tc.border }]}>
            <Text style={[styles.viewLabel, { color: tc.secondaryText }]}>{row.label}</Text>
            {row.editable && onStatusUpdate && row.status ? (
              <TaskStatusBadge
                status={row.status}
                onUpdate={onStatusUpdate}
                onBackdatedComplete={onBackdatedComplete}
              />
            ) : (
              <Text style={[styles.viewValue, { color: tc.text }]}>{row.value}</Text>
            )}
          </View>
        );
      case 'field': {
        const projectId = row.project?.id;
        return (
          <React.Fragment key={row.field}>
            {renderViewRow(
              row.label,
              row.value,
              projectId && onProjectPress ? () => onProjectPress(projectId) : undefined,
              row.project?.accessibilityLabel,
            )}
          </React.Fragment>
        );
      }
      case 'tokens':
        return (
          <View key={row.field} style={styles.viewSection}>
            <Text style={[styles.viewLabel, { color: tc.secondaryText }]}>{row.label}</Text>
            {renderViewPills(row.items, row.field === 'contexts' ? onContextPress : onTagPress)}
          </View>
        );
      case 'description':
        return (
          <View key="description" style={styles.viewSection}>
            <Text style={[styles.viewLabel, { color: tc.secondaryText }]}>{row.label}</Text>
            <View style={[styles.viewCard, { borderColor: tc.border, backgroundColor: tc.inputBg }]}
            >
              <MarkdownText markdown={row.markdown} tc={tc} direction={resolvedDirection} selectable />
            </View>
          </View>
        );
      case 'checklist':
        return (
          <View key="checklist" style={styles.viewSection}>
            <Text style={[styles.viewLabel, { color: tc.secondaryText }]}>
              {row.label}
            </Text>
            <View style={styles.viewChecklist}>
              {row.items.map((item) => {
                const content = (
                  <>
                  {item.completed ? (
                    <CheckSquare size={18} color={tc.tint} strokeWidth={2} />
                  ) : (
                    <Square size={18} color={tc.secondaryText} strokeWidth={2} />
                  )}
                  <MarkdownInlineText
                    markdown={item.title}
                    tc={tc}
                    direction={resolvedDirection}
                    style={[styles.viewChecklistText, textDirectionStyle, { color: tc.text }]}
                  />
                  </>
                );
                if (!row.tappable) {
                  return (
                    <View
                      key={item.id}
                      style={styles.viewChecklistItem}
                      accessibilityLabel={item.accessibilityLabel}
                    >
                      {content}
                    </View>
                  );
                }
                return (
                  <TouchableOpacity
                    key={item.id}
                    style={styles.viewChecklistItem}
                    onPress={() => editChecklist({ kind: 'toggle', index: item.index })}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: item.completed }}
                    accessibilityLabel={item.accessibilityLabel}
                  >
                    {content}
                  </TouchableOpacity>
                );
              })}
              {row.add ? <TextInput
                ref={checklistDraftRef}
                value={checklistDraft}
                onChangeText={updateChecklistDraft}
                onFocus={checklistKeyboard.onFocus}
                onBlur={checklistKeyboard.onBlur}
                onLayout={checklistKeyboard.onLayout}
                onSubmitEditing={() => {
                  if (!editChecklist({ kind: 'append', title: checklistDraft })) {
                    checklistDraftRef.current?.blur();
                    return;
                  }
                  updateChecklistDraft('');
                }}
                placeholder={row.add.placeholder}
                placeholderTextColor={tc.secondaryText}
                style={[styles.viewChecklistAddInput, textDirectionStyle, { color: tc.text }]}
                accessibilityLabel={row.add.label}
                returnKeyType="done"
                blurOnSubmit={false}
                submitBehavior="submit"
              /> : null}
            </View>
          </View>
        );
      case 'attachments':
        return (
          <View key="attachments" style={styles.viewSection}>
            <Text style={[styles.viewLabel, { color: tc.secondaryText }]}>{row.label}</Text>
            <View style={styles.viewAttachmentGrid}>
              {row.items.map(({ attachment, title, image, note, disabled }) => (
                <TouchableOpacity
                  key={attachment.id}
                  style={[styles.viewAttachmentCard, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                  onPress={() => openAttachment(attachment)}
                  disabled={disabled}
                >
                  {image ? (
                    <Image source={{ uri: attachment.uri }} style={styles.viewAttachmentImage} />
                  ) : (
                    <View>
                      <Text style={[styles.viewAttachmentText, { color: tc.text }]} numberOfLines={2}>
                        {title}
                      </Text>
                      {note ? (
                        <Text style={[styles.viewAttachmentSubtext, { color: tc.secondaryText }]}>
                          {note}
                        </Text>
                      ) : null}
                      <AttachmentProgressIndicator attachmentId={attachment.id} />
                    </View>
                  )}
                </TouchableOpacity>
              ))}
            </View>
          </View>
        );
      default:
        return null;
    }
  };

  return (
    <ScrollView
      ref={previewScrollRef}
      style={styles.content}
      contentContainerStyle={[
        styles.contentContainer,
        checklistKeyboard.contentBottomPadding > 0
          ? { paddingBottom: checklistKeyboard.contentBottomPadding }
          : null,
      ]}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'none'}
      onLayout={checklistKeyboard.onLayout}
      onContentSizeChange={checklistKeyboard.onLayout}
      onScroll={checklistKeyboard.onScroll}
      scrollEventThrottle={16}
      nestedScrollEnabled={nestedScrollEnabled}
    >
      {rows.map(renderRow)}
    </ScrollView>
  );
}

export const TaskEditViewTab = React.memo(TaskEditViewTabComponent);
