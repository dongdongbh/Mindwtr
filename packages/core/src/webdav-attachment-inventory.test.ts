import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';
import { parseWebdavAttachmentInventory } from './webdav-attachment-inventory';

const parseXml = (xml: string) => {
    const errors: string[] = [];
    const document = new DOMParser({
        errorHandler: (level, message) => errors.push(`${level}: ${String(message)}`),
    }).parseFromString(xml, 'application/xml') as unknown as Document;
    return { document, errors };
};

const responseXml = (
    href: string,
    options: { collection?: boolean; status?: number } = {},
): string => {
    const status = options.status ?? 200;
    return '<d:response>'
        + `<d:href>${href}</d:href>`
        + '<d:propstat><d:prop><d:resourcetype>'
        + (options.collection ? '<d:collection/>' : '')
        + `</d:resourcetype></d:prop><d:status>HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Error'}</d:status></d:propstat>`
        + '</d:response>';
};

const multistatusXml = (...responses: string[]): string =>
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${responses.join('')}</d:multistatus>`;

describe('parseWebdavAttachmentInventory', () => {
    const collectionUrl = 'https://dav.example.com/mindwtr/attachments/';

    it('requires the exact collection, excludes child collections, and sorts valid keys', () => {
        const xml = multistatusXml(
            responseXml(collectionUrl, { collection: true }),
            responseXml(`${collectionUrl}folder/`, { collection: true }),
            responseXml(`${collectionUrl}z.bin`),
            responseXml(`${collectionUrl}a.bin`),
        );

        expect(parseWebdavAttachmentInventory(xml, collectionUrl, parseXml))
            .toEqual(['attachments/a.bin', 'attachments/z.bin']);
    });

    it.each([
        ['malformed XML', '<d:multistatus xmlns:d="DAV:"><d:response>'],
        ['wrong namespace', '<d:multistatus xmlns:d="urn:not-dav"/>'],
        ['no responses', multistatusXml()],
        ['missing collection response', multistatusXml(responseXml(`${collectionUrl}a.bin`))],
        ['unmatched origin', multistatusXml(
            responseXml(collectionUrl, { collection: true }),
            responseXml('https://other.example.com/mindwtr/attachments/a.bin'),
        )],
        ['query-bearing href', multistatusXml(
            responseXml(collectionUrl, { collection: true }),
            responseXml(`${collectionUrl}a.bin?download=1`),
        )],
        ['ambiguous href', multistatusXml(
            `<d:response><d:href>${collectionUrl}</d:href><d:href>${collectionUrl}a.bin</d:href>`
            + '<d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>'
            + '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>',
        )],
        ['duplicate href', multistatusXml(
            responseXml(collectionUrl, { collection: true }),
            responseXml(`${collectionUrl}a.bin`),
            responseXml(`${collectionUrl}a.bin`),
        )],
        ['failed propstat', multistatusXml(
            responseXml(collectionUrl, { collection: true }),
            responseXml(`${collectionUrl}a.bin`, { status: 403 }),
        )],
        ['nested file', multistatusXml(
            responseXml(collectionUrl, { collection: true }),
            responseXml(`${collectionUrl}nested/a.bin`),
        )],
        ['invalid attachment name', multistatusXml(
            responseXml(collectionUrl, { collection: true }),
            responseXml(`${collectionUrl}bad%20name.bin`),
        )],
        ['malformed escaped href', multistatusXml(
            responseXml(collectionUrl, { collection: true }),
            responseXml(`${collectionUrl}%ZZ.bin`),
        )],
    ] as const)('fails closed on %s', (_case, xml) => {
        expect(() => parseWebdavAttachmentInventory(xml, collectionUrl, parseXml))
            .toThrow(/WebDAV attachment inventory/);
    });
});
