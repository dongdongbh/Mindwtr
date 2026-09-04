import { describe, expect, test } from 'bun:test';
import type { Attachment } from '@mindwtr/core';

import { ValidationError } from './errors.js';
import {
  applyLinkAttachments,
  buildLinkAttachments,
  linkAttachmentInputSchema,
} from './link-attachments.js';

const NOW = '2026-09-03T10:00:00.000Z';

let idCounter = 0;
const makeId = () => `generated-${(idCounter += 1)}`;

const link = (over: Partial<Attachment> = {}): Attachment => ({
  id: 'link-1',
  kind: 'link',
  title: 'Note',
  uri: 'obsidian://open?vault=v&file=note',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const file = (over: Partial<Attachment> = {}): Attachment => ({
  id: 'file-1',
  kind: 'file',
  title: 'Contract.pdf',
  uri: 'attachments/file-1.pdf',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('linkAttachmentInputSchema', () => {
  test('accepts a link item and rejects file-kind or unknown keys', () => {
    expect(linkAttachmentInputSchema.safeParse({ uri: 'https://example.com/a' }).success).toBe(true);
    expect(linkAttachmentInputSchema.safeParse({ kind: 'link', uri: 'https://example.com/a' }).success).toBe(true);
    expect(linkAttachmentInputSchema.safeParse({ kind: 'file', uri: 'x' }).success).toBe(false);
    expect(linkAttachmentInputSchema.safeParse({ uri: 'x', size: 12 }).success).toBe(false);
    expect(linkAttachmentInputSchema.safeParse({ title: 'No uri' }).success).toBe(false);
  });
});

describe('buildLinkAttachments', () => {
  test('generates ids and timestamps and titles from the last uri segment', () => {
    const built = buildLinkAttachments(
      [{ uri: 'https://example.com/docs/spec.md' }, { title: ' Named ', uri: 'file:///home/dd/plan.txt' }],
      NOW,
      makeId,
    );
    expect(built).toHaveLength(2);
    expect(built![0]).toEqual({
      id: built![0].id,
      kind: 'link',
      title: 'spec.md',
      uri: 'https://example.com/docs/spec.md',
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(built![0].id.startsWith('generated-')).toBe(true);
    expect(built![1].title).toBe('Named');
  });

  test('returns undefined for no input so filterUndefined drops the key', () => {
    expect(buildLinkAttachments(undefined)).toBeUndefined();
    expect(buildLinkAttachments([])).toBeUndefined();
  });
});

describe('applyLinkAttachments', () => {
  test('upserts by id', () => {
    const next = applyLinkAttachments([link()], [{ id: 'link-1', title: 'Renamed', uri: 'https://example.com/x' }], NOW, makeId);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ id: 'link-1', title: 'Renamed', uri: 'https://example.com/x', updatedAt: NOW });
    expect(next[0].deletedAt).toBeUndefined();
  });

  test('upserts by uri when no id is given', () => {
    const next = applyLinkAttachments([link()], [{ title: 'Renamed', uri: link().uri }], NOW, makeId);
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe('link-1');
    expect(next[0].title).toBe('Renamed');
  });

  test('tombstones a live link that is not listed, keeping the record', () => {
    const next = applyLinkAttachments([link()], [{ uri: 'https://example.com/new' }], NOW, makeId);
    expect(next).toHaveLength(2);
    const old = next.find((item) => item.id === 'link-1')!;
    expect(old.deletedAt).toBe(NOW);
    expect(next.some((item) => item.uri === 'https://example.com/new' && !item.deletedAt)).toBe(true);
  });

  test('leaves file attachments untouched', () => {
    const existing = [file(), link()];
    const next = applyLinkAttachments(existing, [], NOW, makeId);
    expect(next.find((item) => item.id === 'file-1')).toBe(existing[0]);
    expect(next.find((item) => item.id === 'link-1')!.deletedAt).toBe(NOW);
  });

  test('revives a tombstoned link listed again by id', () => {
    const next = applyLinkAttachments(
      [link({ deletedAt: '2026-02-02T00:00:00.000Z' })],
      [{ id: 'link-1', uri: link().uri }],
      NOW,
      makeId,
    );
    expect(next).toHaveLength(1);
    expect(next[0].deletedAt).toBeUndefined();
    expect(next[0].updatedAt).toBe(NOW);
  });

  test('null removes every live link', () => {
    const next = applyLinkAttachments([file(), link(), link({ id: 'link-2', uri: 'https://example.com/2' })], null, NOW, makeId);
    expect(next.filter((item) => item.kind === 'link' && !item.deletedAt)).toHaveLength(0);
    expect(next).toHaveLength(3);
  });

  test('collapses duplicate uris in one input', () => {
    const next = applyLinkAttachments([], [{ uri: 'https://example.com/a' }, { uri: 'https://example.com/a' }], NOW, makeId);
    expect(next).toHaveLength(1);
  });

  test('throws when an id belongs to a file attachment', () => {
    expect(() => applyLinkAttachments([file()], [{ id: 'file-1', uri: 'https://example.com/a' }], NOW, makeId))
      .toThrow(ValidationError);
  });

  test('rejects UNC and network-share uri forms', () => {
    const rejected = [
      '\\\\host\\share\\file.txt',
      '//host/share/file.txt',
      'file://host/share/file.txt',
      'file://evil.example.com/x',
      'file:////host/share/f',
      'file://///host/share/f',
      'file:\\\\host\\share',
      '/\\host\\share',
      '\\/host\\share',
      'FILE://host/share',
      'file://localhost//host/share',
    ];
    for (const uri of rejected) {
      for (const input of [uri, `  ${uri}  `]) {
        expect(() => applyLinkAttachments([], [{ uri: input }], NOW, makeId)).toThrow(ValidationError);
        expect(() => buildLinkAttachments([{ uri: input }], NOW, makeId)).toThrow(ValidationError);
      }
    }
  });

  test('accepts local and file:// forms that are not network shares', () => {
    const accepted = [
      'file:///C:/x',
      'file:///home/dd/plan.txt',
      'file://localhost/home/dd/plan.txt',
      'C:\\path\\to\\file.txt',
      '/absolute/path/file.txt',
      'relative/looking/path.txt',
      'https://example.com/a',
      'obsidian://open?vault=v&file=note',
      'mailto:someone@example.com',
    ];
    for (const uri of accepted) {
      expect(() => applyLinkAttachments([], [{ uri }], NOW, makeId)).not.toThrow();
      expect(() => buildLinkAttachments([{ uri }], NOW, makeId)).not.toThrow();
    }
  });
});
