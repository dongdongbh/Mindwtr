import React, { useCallback, useEffect, useState } from 'react';
import { Alert } from 'react-native';
import {
  Attachment,
  generateUUID,
  normalizeLinkAttachmentInput,
  Project,
  useTaskStore,
  validateAttachmentForUpload,
} from '@mindwtr/core';
import * as DocumentPicker from 'expo-document-picker';
import * as Linking from 'expo-linking';
import * as Sharing from 'expo-sharing';

import { resolveAttachmentValidationMessage } from './projects-screen.utils';
import { persistAttachmentLocally } from '../../lib/attachment-sync';
import {
  ensureAttachmentAvailableDetailed,
  getAttachmentAvailabilityPatch,
  getAttachmentDownloadIdentity,
  hasAttachmentDownloadIdentity,
  type AttachmentAvailabilityOutcome,
} from '../../lib/attachment-sync-availability';
import { logWarn } from '../../lib/app-log';
import { tryOpenWithAndroidViewer } from '../../lib/open-file-externally';

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

  const currentProjectAttachmentForIdentity = useCallback((
    projectId: string,
    attachmentId: string,
    identity: string,
  ): { project: Project; attachment: Attachment } | null => {
    const selected = selectedProjectRef.current;
    if (!selected || selected.id !== projectId) return null;
    const selectedAttachment = selected.attachments?.find((item) => item.id === attachmentId);
    if (!hasAttachmentDownloadIdentity(selectedAttachment, identity)) return null;
    if (!selectedAttachment.cloudKey) return { project: selected, attachment: selectedAttachment };

    const currentProject = useTaskStore.getState()._allProjects.find((item) => item.id === projectId);
    const currentAttachment = currentProject?.attachments?.find((item) => item.id === attachmentId);
    if (!currentProject || !hasAttachmentDownloadIdentity(currentAttachment, identity)) return null;
    return { project: currentProject, attachment: currentAttachment };
  }, []);

  const updateProjectAttachmentIfCurrent = useCallback((
    projectId: string,
    attachmentId: string,
    identity: string,
    patch: Partial<Attachment>,
  ): Attachment | null => {
    const current = currentProjectAttachmentForIdentity(projectId, attachmentId, identity);
    if (!current) return null;
    const nextAttachment = { ...current.attachment, ...patch };
    const nextAttachments = (current.project.attachments || []).map((item): Attachment =>
      item.id === attachmentId ? { ...item, ...patch } : item
    );
    updateProject(projectId, { attachments: nextAttachments });
    const selected = selectedProjectRef.current;
    const selectedAttachment = selected?.attachments?.find((item) => item.id === attachmentId);
    if (selected?.id === projectId && hasAttachmentDownloadIdentity(selectedAttachment, identity)) {
      setSelectedProject({ ...current.project, attachments: nextAttachments });
    }
    return nextAttachment;
  }, [currentProjectAttachmentForIdentity, setSelectedProject, updateProject]);

  type ProjectAttachmentResolution = AttachmentAvailabilityOutcome | { status: 'stale' };

  const resolveProjectAttachment = useCallback(async (
    projectId: string,
    attachment: Attachment,
  ): Promise<ProjectAttachmentResolution> => {
    if (attachment.kind !== 'file') return { status: 'available', attachment };
    const identity = getAttachmentDownloadIdentity(attachment);
    if (!currentProjectAttachmentForIdentity(projectId, attachment.id, identity)) return { status: 'stale' };
    const shouldDownload = Boolean(
      attachment.cloudKey && (attachment.localStatus === 'missing' || !attachment.uri)
    );
    if (shouldDownload && attachment.localStatus !== 'downloading') {
      updateProjectAttachmentIfCurrent(projectId, attachment.id, identity, { localStatus: 'downloading' });
    }
    const outcome = await ensureAttachmentAvailableDetailed(attachment);
    if (outcome.status === 'available') {
      const current = currentProjectAttachmentForIdentity(projectId, attachment.id, identity);
      if (!current) return { status: 'stale' };
      const resolved = updateProjectAttachmentIfCurrent(
        projectId,
        attachment.id,
        identity,
        getAttachmentAvailabilityPatch(current.attachment, outcome.attachment),
      );
      return resolved
        ? { status: 'available', attachment: resolved }
        : { status: 'stale' };
    }
    if (shouldDownload) {
      const restored = updateProjectAttachmentIfCurrent(
        projectId,
        attachment.id,
        identity,
        { localStatus: 'missing' },
      );
      if (!restored) return { status: 'stale' };
    }
    return outcome;
  }, [currentProjectAttachmentForIdentity, updateProjectAttachmentIfCurrent]);

  const showAttachmentResolutionError = useCallback((resolution: ProjectAttachmentResolution) => {
    if (resolution.status === 'available' || resolution.status === 'stale') return;
    const message = resolution.status === 'generation-conflict'
      ? t('attachments.downloadConflict')
      : t('attachments.missing');
    Alert.alert(t('attachments.title'), message);
  }, [t]);

  const isImageAttachment = useCallback((attachment: Attachment) => {
    const mime = attachment.mimeType?.toLowerCase();
    if (mime?.startsWith('image/')) return true;
    return /\.(png|jpg|jpeg|gif|webp|heic|heif)$/i.test(attachment.uri);
  }, []);

  const openAttachment = useCallback(async (attachment: Attachment) => {
    if (!selectedProject) return;
    const resolution = await resolveProjectAttachment(selectedProject.id, attachment);
    if (resolution.status !== 'available') {
      showAttachmentResolutionError(resolution);
      return;
    }
    const resolved = resolution.attachment;

    if (resolved.kind === 'link') {
      Linking.openURL(resolved.uri).catch((error) => logProjectError('Failed to open attachment URL', error));
      return;
    }
    if (isImageAttachment(resolved)) {
      setImagePreviewAttachment(resolved);
      return;
    }

    // Android: a real ACTION_VIEW open first — the share sheet below only
    // reaches send/save targets, so a PDF "open" only offered saving it.
    if (await tryOpenWithAndroidViewer(resolved.uri, resolved.mimeType)) return;
    const available = await Sharing.isAvailableAsync().catch((error) => {
      void logWarn('[Sharing] availability check failed', {
        scope: 'project',
        extra: { error: error instanceof Error ? error.message : String(error) },
      });
      return false;
    });
    if (available) {
      Sharing.shareAsync(resolved.uri).catch((error) => logProjectError('Failed to share attachment', error));
    } else {
      Linking.openURL(resolved.uri).catch((error) => logProjectError('Failed to open attachment URL', error));
    }
  }, [isImageAttachment, logProjectError, resolveProjectAttachment, selectedProject, showAttachmentResolutionError]);

  useEffect(() => {
    if (!selectedProject) {
      setImagePreviewAttachment(null);
    }
  }, [selectedProject]);

  const downloadAttachment = useCallback(async (attachment: Attachment) => {
    if (!selectedProject) return;
    const resolution = await resolveProjectAttachment(selectedProject.id, attachment);
    showAttachmentResolutionError(resolution);
  }, [resolveProjectAttachment, selectedProject, showAttachmentResolutionError]);

  const addProjectFileAttachment = useCallback(async () => {
    if (!selectedProject) return;
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: false,
      multiple: false,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    const size = asset.size;
    if (typeof size === 'number') {
      const validation = await validateAttachmentForUpload(
        {
          id: 'pending',
          kind: 'file',
          title: asset.name || 'file',
          uri: asset.uri,
          mimeType: asset.mimeType,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        size
      );
      if (!validation.valid) {
        Alert.alert(t('attachments.title'), resolveAttachmentValidationMessage(validation.error, t));
        return;
      }
    }
    const now = new Date().toISOString();
    const attachment: Attachment = {
      id: generateUUID(),
      kind: 'file',
      title: asset.name || 'file',
      uri: asset.uri,
      mimeType: asset.mimeType,
      size: asset.size,
      createdAt: now,
      updatedAt: now,
      localStatus: 'available',
    };
    const cached = await persistAttachmentLocally(attachment);
    if (cached.uri === attachment.uri) {
      Alert.alert(t('attachments.title'), t('attachments.fileNotReadable'));
      return;
    }
    const next = [...(selectedProject.attachments || []), cached];
    updateProject(selectedProject.id, { attachments: next });
    setSelectedProject({ ...selectedProject, attachments: next });
  }, [selectedProject, setSelectedProject, t, updateProject]);

  const confirmAddProjectLink = useCallback(() => {
    if (!selectedProject) return;
    const normalized = normalizeLinkAttachmentInput(linkInput);
    if (!normalized.uri) return;
    const now = new Date().toISOString();
    const attachment: Attachment = {
      id: generateUUID(),
      kind: normalized.kind,
      title: normalized.title,
      uri: normalized.uri,
      createdAt: now,
      updatedAt: now,
    };
    const next = [...(selectedProject.attachments || []), attachment];
    updateProject(selectedProject.id, { attachments: next });
    setSelectedProject({ ...selectedProject, attachments: next });
    setLinkModalVisible(false);
    setLinkInput('');
  }, [linkInput, selectedProject, setSelectedProject, updateProject]);

  const removeProjectAttachment = useCallback((id: string) => {
    if (!selectedProject) return;
    const now = new Date().toISOString();
    const next = (selectedProject.attachments || []).map((attachment) =>
      attachment.id === id ? { ...attachment, deletedAt: now, updatedAt: now } : attachment
    );
    updateProject(selectedProject.id, { attachments: next });
    setSelectedProject({ ...selectedProject, attachments: next });
  }, [selectedProject, setSelectedProject, updateProject]);

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
