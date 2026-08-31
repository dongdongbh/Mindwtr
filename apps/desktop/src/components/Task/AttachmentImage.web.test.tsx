import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { Attachment } from '@mindwtr/core';
import { AttachmentImage } from './AttachmentImage';

const fetchWebCloudAttachmentBlobMock = vi.fn();

vi.mock('../../lib/runtime', () => ({
    isTauriRuntime: () => false,
}));

vi.mock('../../lib/web-attachment-source', () => ({
    fetchWebCloudAttachmentBlob: (...args: unknown[]) => fetchWebCloudAttachmentBlobMock(...args),
    fetchWebCloudAttachmentText: vi.fn(),
}));

const attachment = {
    id: 'attachment-1',
    kind: 'file',
    title: 'photo.png',
    uri: '',
    cloudKey: 'attachments/attachment-1.png',
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
} as Attachment;

describe('AttachmentImage in the web build', () => {
    beforeEach(() => {
        fetchWebCloudAttachmentBlobMock.mockReset();
        (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
    });

    it('renders the cloud blob when the metadata-only attachment can be fetched', async () => {
        fetchWebCloudAttachmentBlobMock.mockResolvedValue('blob:cloud-bytes');

        render(<AttachmentImage attachment={attachment} alt="photo" unavailableText="not available" />);

        await waitFor(() => {
            expect(screen.getByAltText('photo')).toHaveAttribute('src', 'blob:cloud-bytes');
        });
        expect(fetchWebCloudAttachmentBlobMock).toHaveBeenCalledWith(attachment);
    });

    it('shows the unavailable notice when the bytes cannot be fetched', async () => {
        fetchWebCloudAttachmentBlobMock.mockResolvedValue(null);

        render(<AttachmentImage attachment={attachment} alt="photo" unavailableText="not available" />);

        await waitFor(() => {
            expect(screen.getByText('not available')).toBeInTheDocument();
        });
        expect(screen.queryByAltText('photo')).toBeNull();
    });

    it('stays a silent placeholder without an unavailable text (thumbnails)', async () => {
        fetchWebCloudAttachmentBlobMock.mockResolvedValue(null);

        const { container } = render(<AttachmentImage attachment={attachment} alt="photo" />);

        await waitFor(() => {
            expect(fetchWebCloudAttachmentBlobMock).toHaveBeenCalled();
        });
        expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
        expect(screen.queryByAltText('photo')).toBeNull();
    });

    it('does not fetch when the attachment already has a usable uri', async () => {
        render(
            <AttachmentImage
                attachment={{ ...attachment, uri: 'https://example.com/photo.png' } as Attachment}
                alt="photo"
            />,
        );

        expect(screen.getByAltText('photo')).toHaveAttribute('src', 'https://example.com/photo.png');
        expect(fetchWebCloudAttachmentBlobMock).not.toHaveBeenCalled();
    });
});
