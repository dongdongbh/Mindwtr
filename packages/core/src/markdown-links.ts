
export function isSafeMarkdownExternalHref(href: string): boolean {
    return /^(?:https?:\/\/|mailto:|tel:|obsidian:\/\/|upnote:\/\/)/i.test(href);
}
