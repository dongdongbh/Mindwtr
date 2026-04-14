import React from 'react';
import {
    Modal,
    ScrollView,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Ionicons } from '@expo/vector-icons';
import {
    type Attachment,
    getAttachmentDisplayTitle,
    type MarkdownSelection,
    type MarkdownToolbarActionId,
    type MarkdownToolbarResult,
    type Project,
    safeParseDate,
} from '@mindwtr/core';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { ThemeColors } from '@/hooks/use-theme-colors';
import { KeyboardAccessoryHost } from '../../components/keyboard-accessory-host';
import { ExpandedMarkdownEditor } from '../../components/expanded-markdown-editor';
import { MarkdownFormatToolbar } from '../../components/markdown-format-toolbar';
import { MarkdownReferenceAutocomplete } from '../../components/markdown-reference-autocomplete';
import { MarkdownText } from '../../components/markdown-text';
import { TaskList } from '../../components/task-list';
import { AttachmentProgressIndicator } from '../../components/AttachmentProgressIndicator';
import { projectsScreenStyles as styles } from './projects-screen.styles';

type ProjectDetailModalProps = {
    addProjectFileAttachment: () => void | Promise<void>;
    closeProjectDetail: () => void;
    commitSelectedProjectNotes: () => void;
    formatProjectDate: (value: string | undefined, fallback: string) => string;
    handleArchiveSelectedProject: () => void;
    handleSelectedProjectNotesApplyAction: (actionId: MarkdownToolbarActionId, selection: MarkdownSelection) => MarkdownToolbarResult;
    handleSelectedProjectNotesApplyAutocomplete: (next: { selection: MarkdownSelection; value: string }) => void;
    handleSelectedProjectNotesChange: (text: string) => void;
    handleSelectedProjectNotesSelectionChange: (selection: MarkdownSelection) => void;
    handleSelectedProjectNotesUndo: () => MarkdownSelection | undefined;
    handleSetProjectStatus: (status: Project['status']) => void;
    isSelectedProjectNotesFocused: boolean;
    modalHeaderStyle: Array<Record<string, unknown>>;
    notesExpanded: boolean;
    notesFullscreen: boolean;
    onCloseNotesFullscreen: () => void;
    onOpenAreaPicker: () => void;
    onOpenTagPicker: () => void;
    onRemoveProjectAttachment: (id: string) => void;
    onSetLinkInput: (value: string) => void;
    onSetLinkModalVisible: (visible: boolean) => void;
    onSetNotesExpanded: React.Dispatch<React.SetStateAction<boolean>>;
    onSetSelectedProjectNotesFocused: React.Dispatch<React.SetStateAction<boolean>>;
    onSetSelectedProject: React.Dispatch<React.SetStateAction<Project | null>>;
    onSetShowDueDatePicker: React.Dispatch<React.SetStateAction<boolean>>;
    onSetShowNotesFullscreen: React.Dispatch<React.SetStateAction<boolean>>;
    onSetShowNotesPreview: React.Dispatch<React.SetStateAction<boolean>>;
    onSetShowProjectMeta: React.Dispatch<React.SetStateAction<boolean>>;
    onSetShowReviewPicker: React.Dispatch<React.SetStateAction<boolean>>;
    onSetShowStatusMenu: React.Dispatch<React.SetStateAction<boolean>>;
    onDownloadAttachment: (attachment: Attachment) => void | Promise<void>;
    onOpenAttachment: (attachment: Attachment) => void | Promise<void>;
    overlayVisible: boolean;
    presentationStyle: 'pageSheet' | 'fullScreen';
    selectedProjectAreaName: string;
    selectedProject: Project | null;
    selectedProjectNotes: string;
    selectedProjectNotesDirection: 'ltr' | 'rtl';
    selectedProjectNotesInputRef: React.RefObject<TextInput | null>;
    selectedProjectNotesSelection: MarkdownSelection;
    selectedProjectNotesTextDirectionStyle: Record<string, unknown>;
    selectedProjectNotesUndoDepth: number;
    showDueDatePicker: boolean;
    showNotesPreview: boolean;
    showProjectMeta: boolean;
    showReviewPicker: boolean;
    showStatusMenu: boolean;
    statusPalette: Record<Project['status'], { bg: string; border: string; text: string }>;
    t: (key: string) => string;
    tc: ThemeColors;
    updateProject: (id: string, updates: Partial<Project>) => void;
};

export function ProjectDetailModal({
    addProjectFileAttachment,
    closeProjectDetail,
    commitSelectedProjectNotes,
    formatProjectDate,
    handleArchiveSelectedProject,
    handleSelectedProjectNotesApplyAction,
    handleSelectedProjectNotesApplyAutocomplete,
    handleSelectedProjectNotesChange,
    handleSelectedProjectNotesSelectionChange,
    handleSelectedProjectNotesUndo,
    handleSetProjectStatus,
    isSelectedProjectNotesFocused,
    modalHeaderStyle,
    notesExpanded,
    notesFullscreen,
    onCloseNotesFullscreen,
    onDownloadAttachment,
    onOpenAreaPicker,
    onOpenAttachment,
    onOpenTagPicker,
    onRemoveProjectAttachment,
    onSetLinkInput,
    onSetLinkModalVisible,
    onSetNotesExpanded,
    onSetSelectedProject,
    onSetSelectedProjectNotesFocused,
    onSetShowDueDatePicker,
    onSetShowNotesFullscreen,
    onSetShowNotesPreview,
    onSetShowProjectMeta,
    onSetShowReviewPicker,
    onSetShowStatusMenu,
    overlayVisible,
    presentationStyle,
    selectedProjectAreaName,
    selectedProject,
    selectedProjectNotes,
    selectedProjectNotesDirection,
    selectedProjectNotesInputRef,
    selectedProjectNotesSelection,
    selectedProjectNotesTextDirectionStyle,
    selectedProjectNotesUndoDepth,
    showDueDatePicker,
    showNotesPreview,
    showProjectMeta,
    showReviewPicker,
    showStatusMenu,
    statusPalette,
    t,
    tc,
    updateProject,
}: ProjectDetailModalProps) {
    return (
        <Modal
            visible={overlayVisible}
            animationType="slide"
            presentationStyle={presentationStyle}
            allowSwipeDismissal
            onRequestClose={closeProjectDetail}
        >
            <KeyboardAccessoryHost>
                <SafeAreaView style={{ flex: 1, backgroundColor: tc.bg }} edges={['left', 'right', 'bottom']}>
                    {selectedProject ? (
                        <>
                            <View style={modalHeaderStyle}>
                                <TouchableOpacity
                                    onPress={closeProjectDetail}
                                    style={styles.backButton}
                                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                >
                                    <Text style={[styles.backButtonText, { color: tc.tint }]}>{t('common.back') || 'Back'}</Text>
                                </TouchableOpacity>
                                <TextInput
                                    style={[styles.modalTitle, { color: tc.text, marginLeft: 8, flex: 1 }]}
                                    value={selectedProject.title}
                                    onChangeText={(text) => onSetSelectedProject({ ...selectedProject, title: text })}
                                    onSubmitEditing={() => {
                                        const title = selectedProject.title.trim();
                                        if (!title) return;
                                        updateProject(selectedProject.id, { title });
                                        onSetSelectedProject({ ...selectedProject, title });
                                    }}
                                    onEndEditing={() => {
                                        const title = selectedProject.title.trim();
                                        if (!title) return;
                                        updateProject(selectedProject.id, { title });
                                        onSetSelectedProject({ ...selectedProject, title });
                                    }}
                                    returnKeyType="done"
                                />
                                <TouchableOpacity
                                    onPress={() => {
                                        updateProject(selectedProject.id, { isSequential: !selectedProject.isSequential });
                                        onSetSelectedProject({ ...selectedProject, isSequential: !selectedProject.isSequential });
                                    }}
                                    style={[
                                        styles.sequentialToggle,
                                        selectedProject.isSequential && styles.sequentialToggleActive,
                                    ]}
                                >
                                    <Text
                                        style={[
                                            styles.sequentialToggleText,
                                            selectedProject.isSequential && styles.sequentialToggleTextActive,
                                        ]}
                                    >
                                        {selectedProject.isSequential ? '📋 Seq' : '⏸ Par'}
                                    </Text>
                                </TouchableOpacity>
                            </View>
                            <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.projectDetailScroll} keyboardShouldPersistTaps="always">
                                <View style={[styles.statusBlock, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
                                    <View style={styles.statusActionsRow}>
                                        <Text style={[styles.statusLabel, { color: tc.secondaryText }]}>{t('projects.statusLabel')}</Text>
                                        <TouchableOpacity
                                            onPress={() => onSetShowStatusMenu((prev) => !prev)}
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
                                                        style={[styles.statusMenuItem, isActive && { backgroundColor: tc.filterBg }]}
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
                                        onPress={() => onSetShowProjectMeta((prev) => !prev)}
                                    >
                                        <Text style={[styles.detailsToggleText, { color: tc.text }]}>
                                            {showProjectMeta ? '▼' : '▶'} {t('taskEdit.details')}
                                        </Text>
                                    </TouchableOpacity>
                                </View>

                                {showProjectMeta && (
                                    <>
                                        <View style={[styles.reviewContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                                            <Text style={[styles.reviewLabel, { color: tc.text }]}>{t('projects.areaLabel')}</Text>
                                            <TouchableOpacity
                                                style={[styles.reviewButton, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
                                                onPress={onOpenAreaPicker}
                                            >
                                                <Text style={{ color: tc.text }}>{selectedProjectAreaName}</Text>
                                            </TouchableOpacity>
                                        </View>

                                        <View style={[styles.reviewContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                                            <Text style={[styles.reviewLabel, { color: tc.text }]}>{t('taskEdit.tagsLabel')}</Text>
                                            <TouchableOpacity
                                                style={[styles.reviewButton, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
                                                onPress={onOpenTagPicker}
                                            >
                                                <Text style={{ color: tc.text }}>
                                                    {selectedProject.tagIds?.length ? selectedProject.tagIds.join(', ') : t('common.none')}
                                                </Text>
                                            </TouchableOpacity>
                                        </View>

                                        <View style={[styles.notesContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                                            <View style={styles.notesHeaderRow}>
                                                <TouchableOpacity
                                                    style={[styles.notesHeader, { flex: 1 }]}
                                                    onPress={() => {
                                                        onSetNotesExpanded(!notesExpanded);
                                                        if (notesExpanded) onSetShowNotesPreview(false);
                                                    }}
                                                >
                                                    <Text style={[styles.notesTitle, { color: tc.text }]}>
                                                        {notesExpanded ? '▼' : '▶'} {t('project.notes')}
                                                    </Text>
                                                </TouchableOpacity>
                                                {notesExpanded && (
                                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                                        <TouchableOpacity
                                                            onPress={() => onSetShowNotesPreview((value) => !value)}
                                                            style={[styles.smallButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                                                        >
                                                            <Text style={[styles.smallButtonText, { color: tc.tint }]}>
                                                                {showNotesPreview ? t('markdown.edit') : t('markdown.preview')}
                                                            </Text>
                                                        </TouchableOpacity>
                                                        <TouchableOpacity
                                                            onPress={() => onSetShowNotesFullscreen(true)}
                                                            accessibilityRole="button"
                                                            accessibilityLabel={t('markdown.expand')}
                                                            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                                        >
                                                            <Ionicons name="expand-outline" size={20} color={tc.tint} />
                                                        </TouchableOpacity>
                                                    </View>
                                                )}
                                            </View>
                                            {notesExpanded && (
                                                showNotesPreview ? (
                                                    <View style={[styles.markdownPreview, { borderColor: tc.border, backgroundColor: tc.filterBg }]}>
                                                        <MarkdownText markdown={selectedProjectNotes} tc={tc} direction={selectedProjectNotesDirection} />
                                                    </View>
                                                ) : (
                                                    <>
                                                        <MarkdownFormatToolbar
                                                            selection={selectedProjectNotesSelection}
                                                            onSelectionChange={handleSelectedProjectNotesSelectionChange}
                                                            inputRef={selectedProjectNotesInputRef}
                                                            t={t}
                                                            tc={tc}
                                                            visible={isSelectedProjectNotesFocused}
                                                            canUndo={selectedProjectNotesUndoDepth > 0}
                                                            onUndo={handleSelectedProjectNotesUndo}
                                                            onApplyAction={handleSelectedProjectNotesApplyAction}
                                                        />
                                                        <MarkdownReferenceAutocomplete
                                                            value={selectedProjectNotes}
                                                            selection={selectedProjectNotesSelection}
                                                            inputRef={selectedProjectNotesInputRef}
                                                            visible={isSelectedProjectNotesFocused}
                                                            onApplyResult={handleSelectedProjectNotesApplyAutocomplete}
                                                            t={t}
                                                            tc={tc}
                                                        />
                                                        <TextInput
                                                            ref={selectedProjectNotesInputRef}
                                                            style={[
                                                                styles.notesInput,
                                                                selectedProjectNotesTextDirectionStyle,
                                                                { color: tc.text, backgroundColor: tc.inputBg, borderColor: tc.border },
                                                            ]}
                                                            multiline
                                                            placeholder={t('projects.notesPlaceholder')}
                                                            placeholderTextColor={tc.secondaryText}
                                                            value={selectedProjectNotes}
                                                            onFocus={() => onSetSelectedProjectNotesFocused(true)}
                                                            onBlur={() => onSetSelectedProjectNotesFocused(false)}
                                                            onChangeText={handleSelectedProjectNotesChange}
                                                            onSelectionChange={(event) => {
                                                                handleSelectedProjectNotesSelectionChange(event.nativeEvent.selection);
                                                            }}
                                                            selection={selectedProjectNotesSelection}
                                                            onEndEditing={commitSelectedProjectNotes}
                                                        />
                                                    </>
                                                )
                                            )}
                                        </View>

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
                                                            onSetLinkModalVisible(true);
                                                            onSetLinkInput('');
                                                        }}
                                                        style={[styles.smallButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                                                    >
                                                        <Text style={[styles.smallButtonText, { color: tc.tint }]}>{t('attachments.addLink')}</Text>
                                                    </TouchableOpacity>
                                                </View>
                                            </View>
                                            {((selectedProject.attachments || []) as Attachment[]).filter((attachment) => !attachment.deletedAt).length === 0 ? (
                                                <Text style={[styles.helperText, { color: tc.secondaryText }]}>{t('common.none')}</Text>
                                            ) : (
                                                <View style={[styles.attachmentsList, { borderColor: tc.border, backgroundColor: tc.cardBg }]}>
                                                    {((selectedProject.attachments || []) as Attachment[])
                                                        .filter((attachment) => !attachment.deletedAt)
                                                        .map((attachment) => {
                                                            const isMissing = attachment.kind === 'file'
                                                                && (!attachment.uri || attachment.localStatus === 'missing');
                                                            const canDownload = isMissing && Boolean(attachment.cloudKey);
                                                            const isDownloading = attachment.localStatus === 'downloading';
                                                            return (
                                                                <View key={attachment.id} style={[styles.attachmentRow, { borderBottomColor: tc.border }]}>
                                                                    <TouchableOpacity
                                                                        style={styles.attachmentTitleWrap}
                                                                        onPress={() => onOpenAttachment(attachment)}
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
                                                                        <TouchableOpacity onPress={() => onDownloadAttachment(attachment)}>
                                                                            <Text style={[styles.attachmentDownload, { color: tc.tint }]}>
                                                                                {t('attachments.download')}
                                                                            </Text>
                                                                        </TouchableOpacity>
                                                                    ) : isMissing ? (
                                                                        <Text style={[styles.attachmentStatus, { color: tc.secondaryText }]}>
                                                                            {t('attachments.missing')}
                                                                        </Text>
                                                                    ) : null}
                                                                    <TouchableOpacity onPress={() => onRemoveProjectAttachment(attachment.id)}>
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

                                        <View style={[styles.reviewContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                                            <Text style={[styles.reviewLabel, { color: tc.text }]}>{t('taskEdit.dueDateLabel') || 'Due Date'}</Text>
                                            <TouchableOpacity
                                                style={[styles.reviewButton, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
                                                onPress={() => onSetShowDueDatePicker(true)}
                                            >
                                                <Text style={{ color: tc.text }}>
                                                    {formatProjectDate(selectedProject.dueDate, t('common.notSet'))}
                                                </Text>
                                            </TouchableOpacity>
                                            {!!selectedProject.dueDate && (
                                                <TouchableOpacity
                                                    style={styles.clearReviewBtn}
                                                    onPress={() => {
                                                        updateProject(selectedProject.id, { dueDate: undefined });
                                                        onSetSelectedProject({ ...selectedProject, dueDate: undefined });
                                                    }}
                                                >
                                                    <Text style={[styles.clearReviewText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
                                                </TouchableOpacity>
                                            )}
                                            {showDueDatePicker && (
                                                <DateTimePicker
                                                    value={safeParseDate(selectedProject.dueDate) ?? new Date()}
                                                    mode="date"
                                                    display="default"
                                                        onChange={(_, date) => {
                                                            onSetShowDueDatePicker(false);
                                                            if (date) {
                                                                const iso = date.toISOString().slice(0, 10);
                                                                updateProject(selectedProject.id, { dueDate: iso });
                                                                onSetSelectedProject({ ...selectedProject, dueDate: iso });
                                                            }
                                                        }}
                                                />
                                            )}
                                        </View>

                                        <View style={[styles.reviewContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                                            <Text style={[styles.reviewLabel, { color: tc.text }]}>{t('projects.reviewAt') || 'Review Date'}</Text>
                                            <TouchableOpacity
                                                style={[styles.reviewButton, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
                                                onPress={() => onSetShowReviewPicker(true)}
                                            >
                                                <Text style={{ color: tc.text }}>
                                                    {formatProjectDate(selectedProject.reviewAt, t('common.notSet'))}
                                                </Text>
                                            </TouchableOpacity>
                                            {!!selectedProject.reviewAt && (
                                                <TouchableOpacity
                                                    style={styles.clearReviewBtn}
                                                    onPress={() => {
                                                        updateProject(selectedProject.id, { reviewAt: undefined });
                                                        onSetSelectedProject({ ...selectedProject, reviewAt: undefined });
                                                    }}
                                                >
                                                    <Text style={[styles.clearReviewText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
                                                </TouchableOpacity>
                                            )}
                                            {showReviewPicker && (
                                                <DateTimePicker
                                                    value={new Date(selectedProject.reviewAt || Date.now())}
                                                    mode="date"
                                                    display="default"
                                                        onChange={(_, date) => {
                                                            onSetShowReviewPicker(false);
                                                            if (date) {
                                                                const iso = date.toISOString();
                                                                updateProject(selectedProject.id, { reviewAt: iso });
                                                                onSetSelectedProject({ ...selectedProject, reviewAt: iso });
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
                                    allowAdd
                                    staticList
                                    enableBulkActions
                                    showSort={false}
                                />
                            </ScrollView>
                            <ExpandedMarkdownEditor
                                isOpen={notesFullscreen}
                                onClose={onCloseNotesFullscreen}
                                value={selectedProjectNotes}
                                onChange={handleSelectedProjectNotesChange}
                                onCommit={commitSelectedProjectNotes}
                                title={t('project.notes')}
                                headerTitle={selectedProject.title || t('project.notes')}
                                placeholder={t('projects.notesPlaceholder')}
                                t={t}
                                initialMode="edit"
                                direction={selectedProjectNotesDirection}
                                selection={selectedProjectNotesSelection}
                                onSelectionChange={handleSelectedProjectNotesSelectionChange}
                                canUndo={selectedProjectNotesUndoDepth > 0}
                                onUndo={handleSelectedProjectNotesUndo}
                                onApplyAction={handleSelectedProjectNotesApplyAction}
                            />
                        </>
                    ) : null}
                </SafeAreaView>
            </KeyboardAccessoryHost>
        </Modal>
    );
}
