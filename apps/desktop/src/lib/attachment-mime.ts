/** Extension → MIME map shared by the image viewer and the web-build cloud fetcher.
 *  Attachments carry `mimeType` whenever the importer could determine one; this is the
 *  fallback for the ones that don't (and, in the web build, for records whose only
 *  filename is the `cloudKey`). */
const MIME_BY_EXTENSION: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    heic: 'image/heic',
    heif: 'image/heif',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    caf: 'audio/x-caf',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    flac: 'audio/flac',
    webm: 'audio/webm',
    txt: 'text/plain',
    md: 'text/markdown',
    markdown: 'text/markdown',
    json: 'application/json',
    csv: 'text/csv',
    log: 'text/plain',
    yaml: 'text/yaml',
    yml: 'text/yaml',
    toml: 'text/plain',
    ini: 'text/plain',
    cfg: 'text/plain',
    conf: 'text/plain',
    xml: 'application/xml',
    pdf: 'application/pdf',
};

export function inferAttachmentMimeTypeFromUri(uri: string): string | null {
    const path = uri.toLowerCase().split(/[?#]/, 1)[0];
    const extension = path.includes('.') ? path.split('.').pop() : undefined;
    return (extension && MIME_BY_EXTENSION[extension]) || null;
}
