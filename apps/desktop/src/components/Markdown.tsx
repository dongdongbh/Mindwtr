import React from 'react';

import { parseInlineMarkdown } from '@mindwtr/core';
import { cn } from '../lib/utils';
import { InternalMarkdownLink, type InternalMarkdownLinkContext, useInternalMarkdownLinkContext } from './InternalMarkdownLink';

const TASK_LIST_RE = /^(\s*)(?:[-*+]\s+)?\[( |x|X)\]\s+(.+)$/;
const BULLET_LIST_RE = /^(\s*)[-*+]\s+(.+)$/;
// Two spaces (or one tab) per level, the same width the core Tab indent helper and
// the mobile renderer use, so a nested item previews at the same depth everywhere.
const LIST_DEPTH_INDENT_PX = 14;
const getListIndentDepth = (indent: string): number => (
    Math.max(0, Math.floor(indent.replace(/\t/g, '    ').length / 2))
);
const HEADING_RE = /^(#{1,3})\s+(.+)$/;
const HORIZONTAL_RULE_RE = /^(?:-{3,}|\*{3,}|_{3,})$/;

function isBlockBoundary(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('```')) return true;
    if (HEADING_RE.test(trimmed)) return true;
    if (HORIZONTAL_RULE_RE.test(trimmed)) return true;
    if (TASK_LIST_RE.test(line)) return true;
    if (BULLET_LIST_RE.test(line)) return true;
    return false;
}

function renderInline(text: string, options: { interactiveLinks?: boolean; linkContext?: InternalMarkdownLinkContext }): React.ReactNode[] {
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
        if (token.type === 'strike') {
            return <del key={`strike-${index}`}>{token.text}</del>;
        }
        if (token.type === 'link') {
            if (options?.interactiveLinks === false || !options.linkContext) {
                return (
                    <span key={`link-${index}`} className="text-primary underline underline-offset-2">
                        {token.text}
                    </span>
                );
            }
            return (
                <InternalMarkdownLink
                    key={`link-${index}`}
                    href={token.href}
                    className="text-primary underline underline-offset-2 hover:opacity-90"
                    linkContext={options.linkContext}
                >
                    {token.text}
                </InternalMarkdownLink>
            );
        }
        return null;
    }).filter((node): node is string | React.ReactElement => node !== null);
}

export function InlineMarkdown({
    markdown,
    className,
    interactiveLinks = true,
}: {
    markdown: string;
    className?: string;
    interactiveLinks?: boolean;
}) {
    if (interactiveLinks === false) {
        return <span className={className}>{renderInline(markdown || '', { interactiveLinks: false })}</span>;
    }

    return <InteractiveInlineMarkdown markdown={markdown} className={className} />;
}

function InteractiveInlineMarkdown({ markdown, className }: { markdown: string; className?: string }) {
    const linkContext = useInternalMarkdownLinkContext();

    return <span className={className}>{renderInline(markdown || '', { linkContext })}</span>;
}

export function Markdown({ markdown, className }: { markdown: string; className?: string }) {
    const linkContext = useInternalMarkdownLinkContext();
    const source = (markdown || '').replace(/\r\n/g, '\n');
    const lines = source.split('\n');
    const blocks: React.ReactNode[] = [];

    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) {
            blocks.push(
                <div
                    key={`blank-${i}`}
                    aria-hidden="true"
                    className="mindwtr-markdown-blank-line h-4"
                />
            );
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

        const headingMatch = HEADING_RE.exec(line.trim());
        if (headingMatch) {
            const level = headingMatch[1].length;
            const text = headingMatch[2];
            const HeadingTag = level === 1 ? 'h3' : level === 2 ? 'h4' : 'h5';
            blocks.push(
                <HeadingTag key={`h-${i}`} className={cn('font-semibold', level === 1 ? 'text-base' : 'text-sm')}>
                    {renderInline(text, { linkContext })}
                </HeadingTag>
            );
            i += 1;
            continue;
        }

        if (HORIZONTAL_RULE_RE.test(line.trim())) {
            blocks.push(<hr key={`hr-${i}`} className="border-border/70 my-2" />);
            i += 1;
            continue;
        }

        const taskListMatch = TASK_LIST_RE.exec(line);
        if (taskListMatch) {
            const items: { checked: boolean; depth: number; text: string }[] = [];
            const start = i;
            while (i < lines.length) {
                const m = TASK_LIST_RE.exec(lines[i]);
                if (!m) break;
                items.push({ checked: m[2].toLowerCase() === 'x', depth: getListIndentDepth(m[1]), text: m[3] });
                i += 1;
            }
            blocks.push(
                <ul key={`task-ul-${start}`} className="space-y-1 pl-1">
                    {items.map((item, idx) => (
                        <li key={idx} className="flex items-start gap-2" style={item.depth ? { marginLeft: item.depth * LIST_DEPTH_INDENT_PX } : undefined}>
                            <input
                                type="checkbox"
                                checked={item.checked}
                                readOnly
                                disabled
                                className="mt-0.5 h-3.5 w-3.5 rounded border-border"
                            />
                            <span>{renderInline(item.text, { linkContext })}</span>
                        </li>
                    ))}
                </ul>
            );
            continue;
        }

        const listMatch = BULLET_LIST_RE.exec(line);
        if (listMatch) {
            const items: { depth: number; text: string }[] = [];
            const start = i;
            while (i < lines.length) {
                const m = BULLET_LIST_RE.exec(lines[i]);
                if (!m) break;
                items.push({ depth: getListIndentDepth(m[1]), text: m[2] });
                i += 1;
            }
            blocks.push(
                <ul key={`ul-${start}`} className="list-disc pl-5 space-y-1">
                    {items.map((item, idx) => (
                        <li key={idx} style={item.depth ? { marginLeft: item.depth * LIST_DEPTH_INDENT_PX } : undefined}>
                            {renderInline(item.text, { linkContext })}
                        </li>
                    ))}
                </ul>
            );
            continue;
        }

        const paragraph: string[] = [];
        while (i < lines.length && lines[i].trim() && !isBlockBoundary(lines[i])) {
            paragraph.push(lines[i]);
            i += 1;
        }
        const text = paragraph.join(' ').trim();
        if (text) {
            blocks.push(
                <p key={`p-${i}`} className="leading-relaxed">
                    {renderInline(text, { linkContext })}
                </p>
            );
        }
    }

    return <div className={cn('space-y-2 whitespace-pre-wrap break-words', className)}>{blocks}</div>;
}
