import React from 'react';
import type { RecurrenceWeekday } from '@mindwtr/core';
import { ConfirmModal } from '../ConfirmModal';
import { PromptModal } from '../PromptModal';
import { AttachmentModals } from './AttachmentModals';
import { TaskItemRecurrenceModal } from './TaskItemRecurrenceModal';
import { WEEKDAY_ORDER } from './recurrence-constants';

type TaskItemOverlaysProps = {
    applyCustomRecurrence: () => void;
    audioAttachment: any;
    audioError: string | null;
    audioRef: React.RefObject<HTMLAudioElement | null>;
    audioSource: string | null;
    audioTranscribing: boolean;
    audioTranscriptionError: string | null;
    clearLinkPrompt: () => void;
    closeAudio: () => void;
    closeImage: () => void;
    closeText: () => void;
    customInterval: number;
    customMode: 'date' | 'nth';
    customMonthDay: number;
    customOrdinal: '1' | '2' | '3' | '4' | '-1';
    customWeekday: RecurrenceWeekday;
    deleteTask: (taskId: string) => Promise<unknown>;
    handleAddLinkAttachment: (value: string) => boolean;
    handleAudioError: () => void;
    handleDiscardChanges: () => void;
    handleOpenDeleteConfirm: (open: boolean) => void;
    handleOpenDiscardConfirm: (open: boolean) => void;
    imageAttachment: any;
    imageSource: string | null;
    moveTask: (taskId: string, status: any) => Promise<unknown>;
    onOpenImageExternally: () => void;
    onOpenTextExternally: () => void;
    openAudioExternally: () => void;
    openDeleteConfirm: boolean;
    openDiscardConfirm: boolean;
    openLinkPrompt: boolean;
    openWaitingDuePrompt: boolean;
    openWaitingDuePromptSetter: (open: boolean) => void;
    restoreTask: (taskId: string) => Promise<unknown>;
    retryAudioTranscription: () => void;
    setCustomInterval: (value: number) => void;
    setCustomMode: (value: 'date' | 'nth') => void;
    setCustomMonthDay: (value: number) => void;
    setCustomOrdinal: (value: '1' | '2' | '3' | '4' | '-1') => void;
    setCustomWeekday: (value: RecurrenceWeekday) => void;
    setShowCustomRecurrence: (value: boolean) => void;
    showCustomRecurrence: boolean;
    showToast: (message: string, tone?: 'info' | 'error' | 'success', durationMs?: number, action?: { label: string; onClick: () => void }) => void;
    t: (key: string) => string;
    taskId: string;
    textAttachment: any;
    textContent: string;
    textError: string | null;
    textLoading: boolean;
    undoNotificationsEnabled: boolean;
    undoLabel: string;
    updateTask: (taskId: string, patch: Record<string, any>) => Promise<unknown>;
    weekdayLabels: Record<RecurrenceWeekday, string>;
};

export function TaskItemOverlays({
    applyCustomRecurrence,
    audioAttachment,
    audioError,
    audioRef,
    audioSource,
    audioTranscribing,
    audioTranscriptionError,
    clearLinkPrompt,
    closeAudio,
    closeImage,
    closeText,
    customInterval,
    customMode,
    customMonthDay,
    customOrdinal,
    customWeekday,
    deleteTask,
    handleAddLinkAttachment,
    handleAudioError,
    handleDiscardChanges,
    handleOpenDeleteConfirm,
    handleOpenDiscardConfirm,
    imageAttachment,
    imageSource,
    moveTask,
    onOpenImageExternally,
    onOpenTextExternally,
    openAudioExternally,
    openDeleteConfirm,
    openDiscardConfirm,
    openLinkPrompt,
    openWaitingDuePrompt,
    openWaitingDuePromptSetter,
    restoreTask,
    retryAudioTranscription,
    setCustomInterval,
    setCustomMode,
    setCustomMonthDay,
    setCustomOrdinal,
    setCustomWeekday,
    setShowCustomRecurrence,
    showCustomRecurrence,
    showToast,
    t,
    taskId,
    textAttachment,
    textContent,
    textError,
    textLoading,
    undoLabel,
    undoNotificationsEnabled,
    updateTask,
    weekdayLabels,
}: TaskItemOverlaysProps) {
    const resolveText = (key: string, fallback: string) => {
        const value = t(key);
        return value === key ? fallback : value;
    };
    const waitingDuePromptTitle = resolveText('task.waitingDuePromptTitle', 'Set follow-up / review date');
    const waitingDuePromptDescription = resolveText(
        'task.waitingDuePromptDescription',
        'This sets the task review date. When should this waiting task resurface?',
    );
    const skipLabel = resolveText('common.skip', 'Skip');

    return (
        <>
            {showCustomRecurrence && (
                <TaskItemRecurrenceModal
                    t={t}
                    weekdayOrder={WEEKDAY_ORDER}
                    weekdayLabels={weekdayLabels}
                    customInterval={customInterval}
                    customMode={customMode}
                    customOrdinal={customOrdinal}
                    customWeekday={customWeekday}
                    customMonthDay={customMonthDay}
                    onIntervalChange={setCustomInterval}
                    onModeChange={setCustomMode}
                    onOrdinalChange={setCustomOrdinal}
                    onWeekdayChange={setCustomWeekday}
                    onMonthDayChange={(value) => {
                        const safe = Number.isFinite(value) ? Math.min(Math.max(value, 1), 31) : 1;
                        setCustomMonthDay(safe);
                    }}
                    onClose={() => setShowCustomRecurrence(false)}
                    onApply={applyCustomRecurrence}
                />
            )}
            {openLinkPrompt && (
                <PromptModal
                    isOpen={openLinkPrompt}
                    title={t('attachments.addLink')}
                    description={t('attachments.linkInputHint')}
                    placeholder={t('attachments.linkPlaceholder')}
                    defaultValue=""
                    confirmLabel={t('common.save')}
                    cancelLabel={t('common.cancel')}
                    onCancel={clearLinkPrompt}
                    onConfirm={(value) => {
                        const added = handleAddLinkAttachment(value);
                        if (!added) return;
                        clearLinkPrompt();
                    }}
                />
            )}
            {openWaitingDuePrompt && (
                <PromptModal
                    isOpen={openWaitingDuePrompt}
                    title={waitingDuePromptTitle}
                    description={waitingDuePromptDescription}
                    inputType="date"
                    defaultValue=""
                    secondaryLabel={skipLabel}
                    onSecondary={() => {
                        openWaitingDuePromptSetter(false);
                        void moveTask(taskId, 'waiting');
                    }}
                    confirmLabel={t('common.save')}
                    cancelLabel={t('common.cancel')}
                    onCancel={() => openWaitingDuePromptSetter(false)}
                    onConfirm={(value) => {
                        const input = value.trim();
                        if (!input) return;
                        openWaitingDuePromptSetter(false);
                        void moveTask(taskId, 'waiting');
                        void updateTask(taskId, { reviewAt: input });
                    }}
                />
            )}
            {openDeleteConfirm && (
                <ConfirmModal
                    isOpen={openDeleteConfirm}
                    title={resolveText('common.delete', 'Delete task')}
                    description={resolveText('task.deleteConfirmBody', 'Move this task to Trash?')}
                    confirmLabel={resolveText('common.delete', 'Delete')}
                    cancelLabel={t('common.cancel')}
                    onCancel={() => handleOpenDeleteConfirm(false)}
                    onConfirm={() => {
                        handleOpenDeleteConfirm(false);
                        void deleteTask(taskId);
                        const deletedMessage = resolveText('task.aria.delete', 'Task deleted');
                        if (!undoNotificationsEnabled) return;
                        showToast(
                            deletedMessage,
                            'info',
                            5000,
                            {
                                label: undoLabel,
                                onClick: () => {
                                    void restoreTask(taskId);
                                },
                            },
                        );
                    }}
                />
            )}
            {openDiscardConfirm && (
                <ConfirmModal
                    isOpen={openDiscardConfirm}
                    title={resolveText('taskEdit.discardChanges', 'Discard unsaved changes?')}
                    description={resolveText('taskEdit.discardChangesDesc', 'Your changes will be lost if you leave now.')}
                    confirmLabel={resolveText('common.discard', 'Discard')}
                    cancelLabel={t('common.cancel')}
                    onCancel={() => handleOpenDiscardConfirm(false)}
                    onConfirm={() => {
                        handleOpenDiscardConfirm(false);
                        handleDiscardChanges();
                    }}
                />
            )}
            <AttachmentModals
                audioAttachment={audioAttachment}
                audioSource={audioSource}
                audioRef={audioRef}
                audioError={audioError}
                audioTranscribing={audioTranscribing}
                audioTranscriptionError={audioTranscriptionError}
                onCloseAudio={closeAudio}
                onAudioError={handleAudioError}
                onOpenAudioExternally={openAudioExternally}
                onRetryAudioTranscription={retryAudioTranscription}
                imageAttachment={imageAttachment}
                imageSource={imageSource}
                onCloseImage={closeImage}
                onOpenImageExternally={onOpenImageExternally}
                textAttachment={textAttachment}
                textContent={textContent}
                textLoading={textLoading}
                textError={textError}
                onCloseText={closeText}
                onOpenTextExternally={onOpenTextExternally}
                t={t}
            />
        </>
    );
}
