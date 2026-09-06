// Link-kind attachments on the MCP write surface (#1154).
//
// A `kind: "link"` attachment is metadata only ({ title, uri }): nothing to upload, so the
// "attachments need file bytes" reason that keeps `attachments` off the generic per-field
// map does not apply to it. File-kind items stay out (the Zod literal below rejects them).
//
// Update semantics are "this is the complete list of link attachments": links in the input
// are upserted (by id, else by uri), live links not in the input are tombstoned, and file
// attachments are carried through untouched. Tombstoning rather than dropping matters: the
// sync merge unions attachment records by id, so a record that simply vanishes from the
// list is resurrected by the next merge, while a deletedAt marker wins (#1064).
import { randomUUID } from 'node:crypto';
import * as z from 'zod';
import type { Attachment } from '@mindwtr/core';
import { ValidationError } from './errors.js';

export const MAX_LINK_ATTACHMENTS = 50;
export const MAX_LINK_ATTACHMENT_URI_LENGTH = 2048;
export const MAX_LINK_ATTACHMENT_TITLE_LENGTH = 200;

export const linkAttachmentInputSchema = z.object({
  id: z.string().min(1).max(128).optional().describe(
    'Attachment id. Omit to add a new link; pass an existing link\'s id to update it in place.'
  ),
  kind: z.literal('link').optional().describe(
    'Only "link" is accepted here. File attachments carry bytes this interface cannot transport.'
  ),
  title: z.string().max(MAX_LINK_ATTACHMENT_TITLE_LENGTH).optional().describe(
    'Label shown in the app. Defaults to the last path segment of the uri.'
  ),
  uri: z.string().min(1).max(MAX_LINK_ATTACHMENT_URI_LENGTH).describe(
    'What the app opens: https://…, obsidian://…, file://… or a plain path.'
  ),
}).strict();

export type LinkAttachmentInput = z.infer<typeof linkAttachmentInputSchema>;

const LINK_ATTACHMENTS_CREATE_DESCRIPTION = 'Link attachments (kind "link" only): clickable references such as an '
  + 'obsidian:// note, a file:// path or an https:// URL.';
const LINK_ATTACHMENTS_UPDATE_DESCRIPTION = 'The complete list of link attachments the item should have. Links '
  + 'not listed are removed; file attachments are never touched. Pass null or [] to remove every link.';

export const linkAttachmentsCreateSchema = z.array(linkAttachmentInputSchema)
  .max(MAX_LINK_ATTACHMENTS)
  .describe(LINK_ATTACHMENTS_CREATE_DESCRIPTION);
export const linkAttachmentsUpdateSchema = z.array(linkAttachmentInputSchema)
  .max(MAX_LINK_ATTACHMENTS)
  .nullable()
  .describe(LINK_ATTACHMENTS_UPDATE_DESCRIPTION);

const defaultTitle = (uri: string): string => {
  const trimmed = uri.replace(/[/\\]+$/, '');
  const lastSegment = trimmed.split(/[/\\]/).pop() ?? '';
  const withoutQuery = lastSegment.split(/[?#]/, 1)[0] ?? '';
  return withoutQuery || trimmed;
};

type NormalizedLinkInput = { id?: string; title: string; uri: string };

// Desktop's open_path canonicalizes any absolute local path before its allow-list check
// (apps/desktop/src-tauri/src/platform.rs), and on Windows canonicalizing a UNC path performs
// an SMB/NTLM handshake with the host. A writer holding only the sync token (an MCP client,
// possibly a prompt-injected agent) must not be able to plant that. Reject only the
// UNC/network-share forms; file:// and plain local paths stay allowed (#1154 contract).
const isNetworkShareUri = (uri: string): boolean => {
  const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(uri)?.[0];
  if (!scheme) return /^[/\\]{2}/.test(uri);
  if (scheme.toLowerCase() !== 'file:') return false;

  const normalized = uri.slice(scheme.length).replace(/\\/g, '/');
  const authority = /^\/\/([^/]*)/.exec(normalized);
  if (!authority) return false;
  const host = authority[1].toLowerCase();
  return (host !== '' && host !== 'localhost')
    || normalized.slice(authority[0].length).startsWith('//');
};

const normalizeInputs = (inputs: readonly LinkAttachmentInput[]): NormalizedLinkInput[] => {
  const seenUris = new Set<string>();
  const seenIds = new Set<string>();
  const normalized: NormalizedLinkInput[] = [];
  for (const input of inputs) {
    const uri = input.uri.trim();
    if (!uri) throw new ValidationError('Link attachment uri must not be empty');
    if (isNetworkShareUri(uri)) {
      throw new ValidationError(`Link attachment uri must not point at a network share: ${uri}`);
    }
    const id = input.id?.trim() || undefined;
    if (id && seenIds.has(id)) throw new ValidationError(`Duplicate link attachment id: ${id}`);
    if (id) seenIds.add(id);
    // Two entries for one uri would create two links the app cannot tell apart; keep the first.
    if (!id && seenUris.has(uri)) continue;
    seenUris.add(uri);
    const title = input.title?.trim() || defaultTitle(uri);
    normalized.push({ id, title, uri });
  }
  return normalized;
};

/** Attachments for a brand-new task or project: every input becomes a fresh live link. */
export const buildLinkAttachments = (
  inputs: readonly LinkAttachmentInput[] | undefined,
  now: string = new Date().toISOString(),
  makeId: () => string = randomUUID,
): Attachment[] | undefined => {
  if (!inputs || inputs.length === 0) return undefined;
  return normalizeInputs(inputs).map((input) => ({
    id: input.id ?? makeId(),
    kind: 'link' as const,
    title: input.title,
    uri: input.uri,
    createdAt: now,
    updatedAt: now,
  }));
};

/**
 * The full attachments list an update should persist: file attachments and already-deleted
 * links pass through untouched, listed links are upserted, live links left out are
 * tombstoned. `null`/`[]` removes every live link.
 */
export const applyLinkAttachments = (
  existing: readonly Attachment[] | undefined,
  inputs: readonly LinkAttachmentInput[] | null,
  now: string = new Date().toISOString(),
  makeId: () => string = randomUUID,
): Attachment[] => {
  const current = existing ?? [];
  const normalized = normalizeInputs(inputs ?? []);
  const liveLinksById = new Map<string, Attachment>();
  const liveLinksByUri = new Map<string, Attachment>();
  for (const attachment of current) {
    if (attachment.kind !== 'link' || attachment.deletedAt) continue;
    liveLinksById.set(attachment.id, attachment);
    if (!liveLinksByUri.has(attachment.uri)) liveLinksByUri.set(attachment.uri, attachment);
  }
  const anyLinkById = new Map(current.filter((item) => item.kind === 'link').map((item) => [item.id, item]));

  const touched = new Map<string, Attachment>();
  const added: Attachment[] = [];
  for (const input of normalized) {
    const match = input.id
      ? anyLinkById.get(input.id)
      : liveLinksByUri.get(input.uri);
    if (input.id && !match && current.some((item) => item.id === input.id)) {
      throw new ValidationError(`Attachment ${input.id} is not a link attachment`);
    }
    if (match) {
      const unchanged = !match.deletedAt && match.title === input.title && match.uri === input.uri;
      touched.set(match.id, unchanged ? match : {
        ...match,
        title: input.title,
        uri: input.uri,
        deletedAt: undefined,
        updatedAt: now,
      });
      continue;
    }
    added.push({
      id: input.id ?? makeId(),
      kind: 'link',
      title: input.title,
      uri: input.uri,
      createdAt: now,
      updatedAt: now,
    });
  }

  const next = current.map((attachment) => {
    if (attachment.kind !== 'link') return attachment;
    const replacement = touched.get(attachment.id);
    if (replacement) return replacement;
    if (attachment.deletedAt) return attachment;
    return { ...attachment, deletedAt: now, updatedAt: now };
  });
  return [...next, ...added];
};
