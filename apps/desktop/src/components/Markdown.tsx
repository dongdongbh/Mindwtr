import React from 'react';

import { parseInlineMarkdown } from '@mindwtr/core';
import { cn } from '../lib/utils';

function isSafeLink(href: string): boolean {
    try {
        const url = new URL(href);
        return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:';
    } catch {
        return false;
    }
}

function isLocalLink(href: string): boolean {
    if (href.startsWith('file://')) return true;
    if (href.startsWith('/')) return true;
    if (/^[a-zA-Z]:[\\/]/.test(href)) return true;
    if (href.startsWith('~/')) return true;
    return false;
}

async function openLinkTarget(href: string) {
    try {
        const mod = await import('@tauri-apps/plugin-shell');
        await mod.open(href);
    } catch (error) {
        console.error('[Markdown] Failed to open link:', error);
    }
}

function renderInline(text: string): React.ReactNode[] {
    return parseInlineMarkdown(text).map((token, index) => {
        if (token.type === 'text') return token.text;
        if (token.type === 'code') {
            return (
                <code key={`code-${index}`} className="px-1 py-0.5 rounded bg-muted font-mono text-[0.9em]">
                    {token.text}
                </code>
            );
        }
        if (token.type === 'bold') {
            return <strong key={`bold-${index}`}>{token.text}</strong>;
        }
        if (token.type === 'italic') {
            return <em key={`italic-${index}`}>{token.text}</em>;
        }
        if (token.type === 'link') {
            if (isSafeLink(token.href) || isLocalLink(token.href)) {
                const local = isLocalLink(token.href);
                return (
                    <a
                        key={`link-${index}`}
                        href={token.href}
                        target={local ? undefined : '_blank'}
                        rel={local ? undefined : 'noreferrer'}
                        className="text-primary underline underline-offset-2 hover:opacity-90"
                        onClick={(e) => {
                            e.stopPropagation();
                            if (local) {
                                e.preventDefault();
                                void openLinkTarget(token.href);
                            }
                        }}
                    >
                        {token.text}
                    </a>
                );
            }
            return token.text;
        }
        return null;
    }).filter((node): node is string | React.ReactElement => node !== null);
}

export function Markdown({ markdown, className }: { markdown: string; className?: string }) {
    const source = (markdown || '').replace(/\r\n/g, '\n');
    const lines = source.split('\n');
    const blocks: React.ReactNode[] = [];

    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) {
            i += 1;
            continue;
        }

        if (line.trim().startsWith('```')) {
            const start = i + 1;
            let end = start;
            while (end < lines.length && !lines[end].trim().startsWith('```')) end += 1;
            const code = lines.slice(start, end).join('\n');
            blocks.push(
                <pre key={`codeblock-${i}`} className="rounded bg-muted p-3 overflow-x-auto text-xs">
                    <code className="font-mono">{code}</code>
                </pre>
            );
            i = Math.min(end + 1, lines.length);
            continue;
        }

        const headingMatch = /^(#{1,3})\s+(.+)$/.exec(line.trim());
        if (headingMatch) {
            const level = headingMatch[1].length;
            const text = headingMatch[2];
            const HeadingTag = level === 1 ? 'h3' : level === 2 ? 'h4' : 'h5';
            blocks.push(
                <HeadingTag key={`h-${i}`} className={cn('font-semibold', level === 1 ? 'text-base' : 'text-sm')}>
                    {renderInline(text)}
                </HeadingTag>
            );
            i += 1;
            continue;
        }

        const listMatch = /^[-*]\s+(.+)$/.exec(line);
        if (listMatch) {
            const items: string[] = [];
            while (i < lines.length) {
                const m = /^[-*]\s+(.+)$/.exec(lines[i]);
                if (!m) break;
                items.push(m[1]);
                i += 1;
            }
            blocks.push(
                <ul key={`ul-${i}`} className="list-disc pl-5 space-y-1">
                    {items.map((item, idx) => (
                        <li key={idx}>{renderInline(item)}</li>
                    ))}
                </ul>
            );
            continue;
        }

        const paragraph: string[] = [];
        while (i < lines.length && lines[i].trim()) {
            paragraph.push(lines[i]);
            i += 1;
        }
        const text = paragraph.join(' ').trim();
        if (text) {
            blocks.push(
                <p key={`p-${i}`} className="leading-relaxed">
                    {renderInline(text)}
                </p>
            );
        }
    }

    return <div className={cn('space-y-2 whitespace-pre-wrap break-words', className)}>{blocks}</div>;
}
