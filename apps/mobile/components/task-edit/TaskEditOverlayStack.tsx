import React from 'react';

import { AIResponseModal } from '../ai-response-modal';
import { TaskEditAreaPicker } from './TaskEditAreaPicker';
import { TaskEditCustomRecurrenceModal } from './TaskEditCustomRecurrenceModal';
import {
    TaskEditAudioModal,
    TaskEditImagePreviewModal,
    TaskEditLinkModal,
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
        customMonthDay,
        customOrdinal,
        customRecurrenceVisible,
        customWeekday,
        filteredProjectsForPicker,
        imagePreviewAttachment,
        linkInput,
        linkInputTouched,
        linkModalVisible,
        projects,
        recurrenceWeekdayButtons,
        recurrenceWeekdayLabels,
        sectionPickerProjectId,
        setCustomInterval,
        setCustomMode,
        setCustomMonthDay,
        setCustomOrdinal,
        setCustomRecurrenceVisible,
        setCustomWeekday,
        setEditedTask,
        setLinkInput,
        setLinkInputTouched,
        showAreaPicker,
        showProjectPicker,
        showSectionPicker,
        t,
        tc,
        retryAudioTranscription,
        toggleAudioPlayback,
    } = props;

    return (
        <>
            {linkModalVisible ? (
                <TaskEditLinkModal
                    visible
                    t={t}
                    tc={tc}
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
                    customMonthDay={customMonthDay}
                    setCustomMonthDay={setCustomMonthDay}
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
                        setEditedTask((prev: any) => ({
                            ...prev,
                            projectId,
                            areaId: projectId ? undefined : prev.areaId,
                            sectionId: projectId && prev.projectId === projectId ? prev.sectionId : undefined,
                        }));
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
                        setEditedTask((prev: any) => ({ ...prev, sectionId }));
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
                        setEditedTask((prev: any) => ({ ...prev, areaId }));
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
