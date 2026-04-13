export type MultipartAudioFallbackPart = {
  uri: string;
  name: string;
  type: string;
};

export type MultipartAudioPart = Blob | MultipartAudioFallbackPart;

export const normalizeAudioUri = (uri: string): string => {
  if (!uri) return '';
  if (uri.startsWith('content://') || uri.startsWith('file://')) return uri;
  if (uri.startsWith('file:/')) {
    const stripped = uri.replace(/^file:\//, '/');
    return `file://${stripped}`;
  }
  if (uri.startsWith('/')) return `file://${uri}`;
  return uri;
};

export const normalizeAudioUriForFileRead = (uri: string): string => {
  return normalizeAudioUri(uri);
};

export const buildMultipartAudioPart = ({
  uri,
  name,
  type,
  bytes,
}: {
  uri: string;
  name: string;
  type: string;
  bytes?: Uint8Array | null;
}): { part: MultipartAudioPart; fileName?: string } => {
  const BlobCtor = globalThis.Blob;
  if (bytes && bytes.byteLength > 0 && typeof BlobCtor === 'function') {
    try {
      const blobBytes = new Uint8Array(bytes.byteLength);
      blobBytes.set(bytes);
      return {
        part: new BlobCtor([blobBytes.buffer], { type }),
        fileName: name,
      };
    } catch {
      // Fall through to the React Native uri object below.
    }
  }

  return {
    part: { uri, name, type },
  };
};
