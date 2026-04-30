import { useCallback, useEffect, useState } from 'react';
import { Alert } from 'react-native';
import {
  Attachment,
  generateUUID,
  normalizeLinkAttachmentInput,
  Project,
  validateAttachmentForUpload,
} from '@mindwtr/core';
import * as DocumentPicker from 'expo-document-picker';
import * as Linking from 'expo-linking';
import * as Sharing from 'expo-sharing';

import { resolveAttachmentValidationMessage } from './projects-screen.utils';
import { ensureAttachmentAvailable } from '../../lib/attachment-sync';
import { logWarn } from '../../lib/app-log';

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
  const [linkModalVisible, setLinkModalVisible] = useState(false);
  const [imagePreviewAttachment, setImagePreviewAttachment] = useState<Attachment | null>(null);
  const [linkInput, setLinkInput] = useState('');

  const updateAttachmentStatus = useCallback((
    attachments: Attachment[],
    id: string,
    status: Attachment['localStatus']
  ): Attachment[] =>
    attachments.map((item): Attachment =>
      item.id === id ? { ...item, localStatus: status } : item
    ), []);

  const isImageAttachment = useCallback((attachment: Attachment) => {
    const mime = attachment.mimeType?.toLowerCase();
    if (mime?.startsWith('image/')) return true;
    return /\.(png|jpg|jpeg|gif|webp|heic|heif)$/i.test(attachment.uri);
  }, []);

  const openAttachment = useCallback(async (attachment: Attachment) => {
    const shouldDownload = attachment.kind === 'file'
      && attachment.cloudKey
      && (attachment.localStatus === 'missing' || !attachment.uri);
    if (shouldDownload && selectedProject) {
      const next = updateAttachmentStatus(
        selectedProject.attachments || [],
        attachment.id,
        'downloading'
      );
      updateProject(selectedProject.id, { attachments: next });
      setSelectedProject({ ...selectedProject, attachments: next });
    }

    const resolved = await ensureAttachmentAvailable(attachment);
    if (!resolved) {
      if (shouldDownload && selectedProject) {
        const next = updateAttachmentStatus(
          selectedProject.attachments || [],
          attachment.id,
          'missing'
        );
        updateProject(selectedProject.id, { attachments: next });
        setSelectedProject({ ...selectedProject, attachments: next });
      }
      const message = attachment.kind === 'file' ? t('attachments.missing') : t('attachments.fileNotSupported');
      Alert.alert(t('attachments.title'), message);
      return;
    }
    if (resolved.uri !== attachment.uri || resolved.localStatus !== attachment.localStatus) {
      const next = (selectedProject?.attachments || []).map((item): Attachment =>
        item.id === resolved.id ? { ...item, ...resolved } : item
      );
      if (selectedProject) {
        updateProject(selectedProject.id, { attachments: next });
        setSelectedProject({ ...selectedProject, attachments: next });
      }
    }

    if (resolved.kind === 'link') {
      Linking.openURL(resolved.uri).catch((error) => logProjectError('Failed to open attachment URL', error));
      return;
    }
    if (isImageAttachment(resolved)) {
      setImagePreviewAttachment(resolved);
      return;
    }

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
  }, [isImageAttachment, logProjectError, selectedProject, setSelectedProject, t, updateAttachmentStatus, updateProject]);

  useEffect(() => {
    if (!selectedProject) {
      setImagePreviewAttachment(null);
    }
  }, [selectedProject]);

  const downloadAttachment = useCallback(async (attachment: Attachment) => {
    if (!selectedProject) return;
    const shouldDownload = attachment.kind === 'file'
      && attachment.cloudKey
      && (attachment.localStatus === 'missing' || !attachment.uri);
    if (shouldDownload) {
      const next = updateAttachmentStatus(
        selectedProject.attachments || [],
        attachment.id,
        'downloading'
      );
      updateProject(selectedProject.id, { attachments: next });
      setSelectedProject({ ...selectedProject, attachments: next });
    }

    const resolved = await ensureAttachmentAvailable(attachment);
    if (!resolved) {
      const next = updateAttachmentStatus(
        selectedProject.attachments || [],
        attachment.id,
        'missing'
      );
      updateProject(selectedProject.id, { attachments: next });
      setSelectedProject({ ...selectedProject, attachments: next });
      const message = attachment.kind === 'file' ? t('attachments.missing') : t('attachments.fileNotSupported');
      Alert.alert(t('attachments.title'), message);
      return;
    }
    if (resolved.uri !== attachment.uri || resolved.localStatus !== attachment.localStatus) {
      const next = (selectedProject.attachments || []).map((item): Attachment =>
        item.id === resolved.id ? { ...item, ...resolved } : item
      );
      updateProject(selectedProject.id, { attachments: next });
      setSelectedProject({ ...selectedProject, attachments: next });
    }
  }, [selectedProject, setSelectedProject, t, updateAttachmentStatus, updateProject]);

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
    const next = [...(selectedProject.attachments || []), attachment];
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
