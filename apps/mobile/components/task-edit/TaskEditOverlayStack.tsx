import React from 'react';

import { AIResponseModal } from '../ai-response-modal';
import { TaskEditAreaPicker } from './TaskEditAreaPicker';
import { TaskEditCustomRecurrenceModal } from './TaskEditCustomRecurrenceModal';
import {
    TaskEditAudioModal,
    TaskEditImagePreviewModal,
    TaskEditLinkModal,
    TaskEditWaitingAssignmentModal,
} from './TaskEditOverlayModals';
import { TaskEditProjectPicker } from './TaskEditProjectPicker';
import { TaskEditSectionPicker } from './TaskEditSectionPicker';

type TaskEditOverlayStackProps = {
    [key: string]: any;
};

export function TaskEditOverlayStack(props: TaskEditOverlayStackProps) {
    const {
        aiModal,
        applyCustomRecurrence,
        areas,
        audioAttachment,
        audioLoading,
        audioTranscribing,
        audioTranscriptionError,
        audioModalVisible,
        audioStatus,
        closeAIModal,
        closeAudioModal,
        closeImagePreview,
        closeLinkModal,
        confirmAddLink,
        customInterval,
        customMode,
        customMonthDays,
        customOrdinal,
        customRecurrenceVisible,
        customWeekday,
        draft,
        filteredProjectsForPicker,
        imagePreviewAttachment,
        linkInput,
        linkInputTouched,
        linkModalVisible,
        linkModalTitle,
        projects,
        recurrenceWeekdayButtons,
        recurrenceWeekdayLabels,
        sectionPickerProjectId,
        setCustomInterval,
        setCustomMode,
        toggleCustomMonthDay,
        setCustomOrdinal,
        setCustomRecurrenceVisible,
        setCustomWeekday,
        setDraftField,
        setLinkInput,
        setLinkInputTouched,
        showAreaPicker,
        showProjectPicker,
        showSectionPicker,
        t,
        tc,
        retryAudioTranscription,
        toggleAudioPlayback,
        waitingAssignmentInput,
        waitingAssignmentModalVisible,
        waitingAssignmentSuggestions,
        closeWaitingAssignmentModal,
        confirmWaitingAssignment,
        setWaitingAssignmentInput,
    } = props;

    return (
        <>
            {linkModalVisible ? (
                <TaskEditLinkModal
                    visible
                    t={t}
                    tc={tc}
                    title={linkModalTitle}
                    linkInput={linkInput}
                    linkInputTouched={linkInputTouched}
                    onChangeLinkInput={(text: string) => {
                        setLinkInput(text);
                        setLinkInputTouched(true);
                    }}
                    onBlurLinkInput={() => setLinkInputTouched(true)}
                    onClose={closeLinkModal}
                    onSave={confirmAddLink}
                />
            ) : null}
            {waitingAssignmentModalVisible ? (
                <TaskEditWaitingAssignmentModal
                    visible
                    t={t}
                    tc={tc}
                    value={waitingAssignmentInput}
                    suggestions={waitingAssignmentSuggestions}
                    onChangeValue={setWaitingAssignmentInput}
                    onClose={closeWaitingAssignmentModal}
                    onSave={confirmWaitingAssignment}
                />
            ) : null}
            {audioModalVisible ? (
                <TaskEditAudioModal
                    visible
                    t={t}
                    tc={tc}
                    audioTitle={audioAttachment?.title}
                    audioStatus={audioStatus}
                    audioLoading={audioLoading}
                    audioTranscribing={audioTranscribing}
                    audioTranscriptionError={audioTranscriptionError}
                    onTogglePlayback={() => {
                        void toggleAudioPlayback();
                    }}
                    onRetryTranscription={() => {
                        void retryAudioTranscription();
                    }}
                    onClose={closeAudioModal}
                />
            ) : null}
            {imagePreviewAttachment ? (
                <TaskEditImagePreviewModal
                    visible
                    t={t}
                    tc={tc}
                    imagePreviewAttachment={imagePreviewAttachment}
                    onClose={closeImagePreview}
                />
            ) : null}
            {customRecurrenceVisible ? (
                <TaskEditCustomRecurrenceModal
                    visible
                    t={t}
                    tc={tc}
                    styles={props.styles}
                    customInterval={customInterval}
                    setCustomInterval={setCustomInterval}
                    customMode={customMode}
                    setCustomMode={setCustomMode}
                    customOrdinal={customOrdinal}
                    setCustomOrdinal={setCustomOrdinal}
                    customWeekday={customWeekday}
                    setCustomWeekday={setCustomWeekday}
                    customMonthDays={customMonthDays}
                    toggleCustomMonthDay={toggleCustomMonthDay}
                    recurrenceWeekdayButtons={recurrenceWeekdayButtons}
                    recurrenceWeekdayLabels={recurrenceWeekdayLabels}
                    onClose={() => setCustomRecurrenceVisible(false)}
                    onSave={applyCustomRecurrence}
                />
            ) : null}
            {showProjectPicker ? (
                <TaskEditProjectPicker
                    visible
                    projects={filteredProjectsForPicker}
                    allProjects={projects}
                    tc={tc}
                    t={t}
                    onClose={() => props.setShowProjectPicker(false)}
                    onSelectProject={(projectId?: string) => {
                        const areaId = draft?.areaId
                            || projects.find((project: any) => project.id === draft?.projectId)?.areaId
                            || '';
                        setDraftField('projectId', projectId ?? '');
                        setDraftField('areaId', projectId ? '' : areaId);
                        setDraftField('sectionId', projectId && draft?.projectId === projectId ? draft.sectionId : '');
                    }}
                    onCreateProject={(title: string) => (
                        props.addProject(
                            title,
                            props.DEFAULT_PROJECT_COLOR,
                            props.projectFilterAreaId ? { areaId: props.projectFilterAreaId } : undefined,
                        )
                    )}
                />
            ) : null}
            {showSectionPicker ? (
                <TaskEditSectionPicker
                    visible
                    projectId={sectionPickerProjectId}
                    sections={props.sectionPickerSections}
                    tc={tc}
                    t={t}
                    onClose={() => props.setShowSectionPicker(false)}
                    onSelectSection={(sectionId?: string) => {
                        setDraftField('sectionId', sectionId ?? '');
                    }}
                    onCreateSection={(projectId: string, title: string) => props.addSection(projectId, title)}
                />
            ) : null}
            {showAreaPicker ? (
                <TaskEditAreaPicker
                    visible
                    areas={areas}
                    tc={tc}
                    t={t}
                    onClose={() => props.setShowAreaPicker(false)}
                    onSelectArea={(areaId: string | undefined) => {
                        setDraftField('areaId', areaId ?? '');
                    }}
                    onCreateArea={(name: string) => props.addArea(name)}
                />
            ) : null}
            {aiModal ? (
                <AIResponseModal
                    visible
                    title={aiModal.title}
                    message={aiModal.message}
                    actions={aiModal.actions}
                    onClose={closeAIModal}
                />
            ) : null}
        </>
    );
}
