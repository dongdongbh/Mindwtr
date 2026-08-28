import { sanitizeAttachmentCloudKeyForSyncMerge } from './sync-normalization';

const DAV_NAMESPACE = 'DAV:';

export type WebdavXmlParseResult = {
    document: Document;
    errors?: readonly string[];
};

export type WebdavXmlParser = (xml: string) => WebdavXmlParseResult;

const directDavChildren = (element: Element, localName: string): Element[] =>
    Array.from(element.childNodes).filter((node): node is Element => (
        node.nodeType === 1
        && (node as Element).namespaceURI === DAV_NAMESPACE
        && (node as Element).localName === localName
    ));

const requireSuccessfulDavStatus = (element: Element, context: string): void => {
    const statuses = directDavChildren(element, 'status');
    if (statuses.length !== 1) throw new Error(`WebDAV attachment inventory ${context} status is ambiguous`);
    const match = statuses[0]?.textContent?.trim().match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s|$)/i);
    const status = match ? Number.parseInt(match[1]!, 10) : Number.NaN;
    if (!Number.isInteger(status) || status < 200 || status >= 300) {
        throw new Error(`WebDAV attachment inventory ${context} failed (${Number.isInteger(status) ? status : 'malformed status'})`);
    }
};

const parseHref = (rawHref: string, collectionUrl: string): URL => {
    try {
        return new URL(rawHref, collectionUrl);
    } catch {
        throw new Error('WebDAV attachment inventory returned a malformed href');
    }
};

const decodePath = (pathname: string): string => {
    try {
        return decodeURIComponent(pathname);
    } catch {
        throw new Error('WebDAV attachment inventory returned a malformed href');
    }
};

/**
 * Parse and validate the authoritative Depth:1 attachment collection response.
 * Request/auth/timeout handling stays in each platform adapter; all security-sensitive
 * DAV namespace, status, href, confinement, and attachment-name policy lives here.
 */
export const parseWebdavAttachmentInventory = (
    xml: string,
    collectionUrl: string,
    parseXml: WebdavXmlParser,
): string[] => {
    const { document, errors = [] } = parseXml(xml);
    const root = document.documentElement;
    if (errors.length > 0 || !root || root.namespaceURI !== DAV_NAMESPACE || root.localName !== 'multistatus') {
        throw new Error('WebDAV attachment inventory response is not a valid DAV:multistatus document');
    }

    const responses = directDavChildren(root, 'response');
    if (responses.length === 0) throw new Error('WebDAV attachment inventory has no DAV:response entries');
    const requested = parseHref(collectionUrl, collectionUrl);
    const collectionPath = decodePath(requested.pathname).replace(/\/+$/, '/');
    const seenPaths = new Set<string>();
    const keys = new Set<string>();
    let matchedCollection = false;

    for (const response of responses) {
        const hrefs = directDavChildren(response, 'href');
        if (hrefs.length !== 1 || !hrefs[0]?.textContent?.trim()) {
            throw new Error('WebDAV attachment inventory DAV:response href is ambiguous');
        }
        const href = parseHref(hrefs[0].textContent.trim(), collectionUrl);
        if (href.origin !== requested.origin || href.search || href.hash) {
            throw new Error('WebDAV attachment inventory returned an unmatched href');
        }
        const path = decodePath(href.pathname);
        const normalizedPath = path.endsWith('/') ? path.replace(/\/+$/, '/') : path;
        if (seenPaths.has(normalizedPath)) {
            throw new Error('WebDAV attachment inventory returned a duplicate href');
        }
        seenPaths.add(normalizedPath);

        const responseStatuses = directDavChildren(response, 'status');
        if (responseStatuses.length > 0) requireSuccessfulDavStatus(response, `response for ${path}`);
        const propstats = directDavChildren(response, 'propstat');
        if (propstats.length === 0) {
            throw new Error(`WebDAV attachment inventory response for ${path} has no DAV:propstat`);
        }
        let resourceType: Element | null = null;
        for (const propstat of propstats) {
            requireSuccessfulDavStatus(propstat, `propstat for ${path}`);
            const props = directDavChildren(propstat, 'prop');
            if (props.length !== 1) {
                throw new Error(`WebDAV attachment inventory properties for ${path} are ambiguous`);
            }
            const resourceTypes = directDavChildren(props[0]!, 'resourcetype');
            if (resourceTypes.length > 1 || (resourceTypes.length === 1 && resourceType)) {
                throw new Error(`WebDAV attachment inventory resource type for ${path} is ambiguous`);
            }
            resourceType = resourceTypes[0] ?? resourceType;
        }
        if (!resourceType) {
            throw new Error(`WebDAV attachment inventory response for ${path} has no DAV:resourcetype`);
        }
        const isCollection = directDavChildren(resourceType, 'collection').length > 0;
        if (normalizedPath === collectionPath) {
            if (!isCollection || matchedCollection) {
                throw new Error('WebDAV attachment inventory requested collection is ambiguous');
            }
            matchedCollection = true;
            continue;
        }
        if (!normalizedPath.startsWith(collectionPath)) {
            throw new Error('WebDAV attachment inventory returned an unmatched href');
        }
        const leaf = normalizedPath.slice(collectionPath.length).replace(/\/+$/, '');
        if (!leaf || leaf.includes('/')) {
            throw new Error('WebDAV attachment inventory returned a non-child href');
        }
        if (isCollection) continue;
        const key = sanitizeAttachmentCloudKeyForSyncMerge(`attachments/${leaf}`);
        if (!key?.startsWith('attachments/')) {
            throw new Error('WebDAV attachment inventory returned an invalid attachment name');
        }
        keys.add(key);
    }
    if (!matchedCollection) {
        throw new Error('WebDAV attachment inventory did not identify the requested collection');
    }
    return Array.from(keys).sort();
};
