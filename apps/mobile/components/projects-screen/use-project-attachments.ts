import React, { useCallback, useEffect, useState } from 'react';
import { Alert } from 'react-native';
import {
  Attachment,
  addPickedAttachment,
  attachmentPatchChanges,
  findProjectAttachmentForIdentity,
  generateUUID,
  getAttachmentOpenLinkFailedMessage,
  getAttachmentResolutionMessage,
  isSandboxMode,
  logAttachmentWriteSkipped,
  patchAttachment,
  planAttachmentLinkBatch,
  planAttachmentOpen,
  Project,
  resolveAttachmentAvailability,
  runStoreCommand,
  softDeleteAttachment,
  type AttachmentResolution,
  useTaskStore,
} from '@mindwtr/core';
import * as DocumentPicker from 'expo-document-picker';
import * as Linking from 'expo-linking';
import * as Sharing from 'expo-sharing';

import { persistAttachmentLocally } from '../../lib/attachment-sync';
import { hasAttachmentDownloadIdentity } from '../../lib/attachment-sync-availability';
import { attachmentAvailabilityPort } from '../../lib/attachment-availability-port';
import { logWarn } from '../../lib/app-log';
import { tryOpenWithAndroidViewer } from '../../lib/open-file-externally';
import { openExternalLink } from '../../lib/open-external-link';

type UseProjectAttachmentsParams = {
  selectedProject: Project | null;
  setSelectedProject: (project: Project | null) => void;
  updateProject: (id: string, updates: Partial<Project>) => unknown;
  t: (key: string) => string;
  logProjectError: (message: string, error?: unknown) => void;
};

export function useProjectAttachments({
  selectedProject,
  setSelectedProject,
  updateProject,
  t,
  logProjectError,
}: UseProjectAttachmentsParams) {
  const selectedProjectRef = React.useRef(selectedProject);
  selectedProjectRef.current = selectedProject;
  const [linkModalVisible, setLinkModalVisible] = useState(false);
  const [imagePreviewAttachment, setImagePreviewAttachment] = useState<Attachment | null>(null);
  const [linkInput, setLinkInput] = useState('');
  const showSandboxUnavailable = useCallback(() => {
    Alert.alert(t('attachments.title'), t('sandbox.unavailable'));
  }, [t]);

  const getMutableSelectedProject = useCallback((expectedId?: string): Project | null => {
    const selected = selectedProjectRef.current;
    if (!selected || selected.status === 'archived') return null;
    if (expectedId && selected.id !== expectedId) return null;
    const stored = useTaskStore.getState()._allProjects?.find((item) => item.id === selected.id);
    if (stored?.status === 'archived') return null;
    return selected;
  }, []);

  const currentProjectAttachmentForIdentity = useCallback((
    projectId: string,
    attachmentId: string,
    identity: string,
  ): { project: Project; attachment: Attachment } | null => findProjectAttachmentForIdentity({
    selected: selectedProjectRef.current,
    stored: (id) => useTaskStore.getState()._allProjects.find((item) => item.id === id),
    projectId,
    attachmentId,
    identity,
    has: (attachment, expected): attachment is Attachment => hasAttachmentDownloadIdentity(attachment, expected),
  }), []);

  // One store command reads the row, builds the whole attachment list and writes it: a sync save admitted first
  // publishes newer rows (a sibling another device added), and a list built before it would drop them.
  const updateProjectAttachmentIfCurrent = useCallback((
    projectId: string,
    attachmentId: string,
    identity: string,
    patch: Partial<Attachment>,
  ): Promise<Attachment | null> => runStoreCommand(async () => {
    const current = currentProjectAttachmentForIdentity(projectId, attachmentId, identity);
    if (!current) return null;
    const nextAttachment = { ...current.attachment, ...patch };
    if (!attachmentPatchChanges(current.attachment, patch)) {
      logAttachmentWriteSkipped();
      return nextAttachment;
    }
    const stored = useTaskStore.getState()._allProjects.find((item) => item.id === projectId);
    const base = stored ?? current.project;
    const nextAttachments = patchAttachment(base.attachments || [], attachmentId, patch);
    const written = updateProject(projectId, { attachments: nextAttachments });
    const selected = selectedProjectRef.current;
    const selectedAttachment = selected?.attachments?.find((item) => item.id === attachmentId);
    if (selected?.id === projectId && hasAttachmentDownloadIdentity(selectedAttachment, identity)) {
      setSelectedProject({ ...base, attachments: nextAttachments });
    }
    await written;
    return nextAttachment;
  }), [currentProjectAttachmentForIdentity, setSelectedProject, updateProject]);

  // Same rule for the add and remove buttons: [build] gets the list as stored when the write is admitted.
  const writeProjectAttachments = useCallback((
    projectId: string,
    build: (attachments: Attachment[]) => Attachment[],
  ): Promise<void> => runStoreCommand(async () => {
    const stored = useTaskStore.getState()._allProjects.find((item) => item.id === projectId);
    const selected = selectedProjectRef.current;
    const base = stored ?? (selected?.id === projectId ? selected : null);
    if (!base || base.status === 'archived') return;
    const next = build(base.attachments || []);
    const written = updateProject(projectId, { attachments: next });
    if (selectedProjectRef.current?.id === projectId) setSelectedProject({ ...base, attachments: next });
    await written;
  }), [setSelectedProject, updateProject]);

  const resolveProjectAttachment = useCallback((
    projectId: string,
    attachment: Attachment,
  ): Promise<AttachmentResolution> => resolveAttachmentAvailability(attachment, {
    availability: attachmentAvailabilityPort,
    current: (attachmentId, identity) => currentProjectAttachmentForIdentity(projectId, attachmentId, identity)?.attachment ?? null,
    update: (attachmentId, identity, patch) => updateProjectAttachmentIfCurrent(projectId, attachmentId, identity, patch),
  }), [currentProjectAttachmentForIdentity, updateProjectAttachmentIfCurrent]);

  const showAttachmentResolutionError = useCallback((resolution: AttachmentResolution) => {
    const message = getAttachmentResolutionMessage(resolution, t);
    if (message) Alert.alert(t('attachments.title'), message);
  }, [t]);

  const openAttachment = useCallback(async (attachment: Attachment) => {
    if (isSandboxMode()) {
      showSandboxUnavailable();
      return;
    }
    if (!selectedProject) return;
    const resolution = await resolveProjectAttachment(selectedProject.id, attachment);
    if (resolution.status !== 'available') {
      showAttachmentResolutionError(resolution);
      return;
    }
    const plan = planAttachmentOpen(resolution.attachment, { audio: false, t });
    if (plan.kind === 'alert') {
      Alert.alert(t('attachments.title'), plan.message);
      return;
    }
    if (plan.kind === 'link') {
      if (/^upnote:\/\//i.test(plan.uri)) {
        await openExternalLink(plan.uri, t, 'attachment');
      } else {
        Linking.openURL(plan.uri).catch((error) => {
          logProjectError('Failed to open attachment URL', error);
          Alert.alert(t('attachments.title'), getAttachmentOpenLinkFailedMessage(t));
        });
      }
      return;
    }
    // `audio: false`: the project screen has no player, so audio opens as a file.
    if (plan.kind !== 'file') {
      setImagePreviewAttachment(plan.attachment);
      return;
    }

    // Android: a real ACTION_VIEW open first — the share sheet below only
    // reaches send/save targets, so a PDF "open" only offered saving it.
    if (await tryOpenWithAndroidViewer(plan.uri, plan.mimeType ?? undefined)) return;
    const available = await Sharing.isAvailableAsync().catch((error) => {
      void logWarn('[Sharing] availability check failed', {
        scope: 'project',
        extra: { error: error instanceof Error ? error.message : String(error) },
      });
      return false;
    });
    if (available) {
      Sharing.shareAsync(plan.uri).catch((error) => logProjectError('Failed to share attachment', error));
    } else {
      Linking.openURL(plan.uri).catch((error) => logProjectError('Failed to open attachment URL', error));
    }
  }, [logProjectError, resolveProjectAttachment, selectedProject, showAttachmentResolutionError, showSandboxUnavailable, t]);

  useEffect(() => {
    if (!selectedProject) {
      setImagePreviewAttachment(null);
    }
    if (selectedProject?.status === 'archived') {
      setLinkModalVisible(false);
      setLinkInput('');
    }
  }, [selectedProject]);

  const downloadAttachment = useCallback(async (attachment: Attachment) => {
    if (isSandboxMode()) {
      showSandboxUnavailable();
      return;
    }
    if (!selectedProject) return;
    const resolution = await resolveProjectAttachment(selectedProject.id, attachment);
    showAttachmentResolutionError(resolution);
  }, [resolveProjectAttachment, selectedProject, showAttachmentResolutionError, showSandboxUnavailable]);

  const addProjectFileAttachment = useCallback(async () => {
    if (isSandboxMode()) {
      showSandboxUnavailable();
      return;
    }
    const projectAtStart = getMutableSelectedProject();
    if (!projectAtStart) return;
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: false,
      multiple: false,
    });
    if (result.canceled) return;
    const outcome = await addPickedAttachment({
      source: 'file',
      asset: result.assets[0],
      newId: () => generateUUID(),
      persist: (attachment) => persistAttachmentLocally(attachment),
      t,
    });
    if (outcome.kind === 'refused') {
      Alert.alert(t('attachments.title'), outcome.message);
      return;
    }
    const current = getMutableSelectedProject(projectAtStart.id);
    if (!current) return;
    await writeProjectAttachments(current.id, (attachments) => [...attachments, outcome.attachment]);
  }, [getMutableSelectedProject, showSandboxUnavailable, t, writeProjectAttachments]);

  const confirmAddProjectLink = useCallback(() => {
    if (isSandboxMode()) {
      showSandboxUnavailable();
      return;
    }
    const current = getMutableSelectedProject();
    if (!current) return;
    const batch = planAttachmentLinkBatch(linkInput, { newId: () => generateUUID(), now: new Date().toISOString(), t });
    if (batch.kind === 'refused') {
      Alert.alert(t('attachments.title'), batch.message);
      return;
    }
    if (batch.kind === 'nothing') return;
    void writeProjectAttachments(current.id, (attachments) => [...attachments, ...batch.added]);
    setLinkModalVisible(false);
    setLinkInput('');
  }, [getMutableSelectedProject, linkInput, showSandboxUnavailable, t, writeProjectAttachments]);

  const removeProjectAttachment = useCallback((id: string) => {
    const current = getMutableSelectedProject();
    if (!current) return;
    const now = new Date().toISOString();
    void writeProjectAttachments(current.id, (attachments) => softDeleteAttachment(attachments, id, now));
  }, [getMutableSelectedProject, writeProjectAttachments]);

  const resetProjectAttachmentUi = useCallback(() => {
    setImagePreviewAttachment(null);
    setLinkModalVisible(false);
    setLinkInput('');
  }, []);

  return {
    linkModalVisible,
    setLinkModalVisible,
    imagePreviewAttachment,
    setImagePreviewAttachment,
    linkInput,
    setLinkInput,
    openAttachment,
    downloadAttachment,
    addProjectFileAttachment,
    confirmAddProjectLink,
    removeProjectAttachment,
    resetProjectAttachmentUi,
  };
}
