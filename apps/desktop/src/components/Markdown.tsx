import React from 'react';

import { parseInlineMarkdown } from '@mindwtr/core';
import { cn } from '../lib/utils';
import { InternalMarkdownLink } from './InternalMarkdownLink';

const TASK_LIST_RE = /^\s{0,3}(?:[-*+]\s+)?\[( |x|X)\]\s+(.+)$/;
const BULLET_LIST_RE = /^\s{0,3}[-*+]\s+(.+)$/;
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
            return (
                <InternalMarkdownLink
                    key={`link-${index}`}
                    href={token.href}
                    className="text-primary underline underline-offset-2 hover:opacity-90"
                >
                    {token.text}
                </InternalMarkdownLink>
            );
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

        const headingMatch = HEADING_RE.exec(line.trim());
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

        if (HORIZONTAL_RULE_RE.test(line.trim())) {
            blocks.push(<hr key={`hr-${i}`} className="border-border/70 my-2" />);
            i += 1;
            continue;
        }

        const taskListMatch = TASK_LIST_RE.exec(line);
        if (taskListMatch) {
            const items: { checked: boolean; text: string }[] = [];
            const start = i;
            while (i < lines.length) {
                const m = TASK_LIST_RE.exec(lines[i]);
                if (!m) break;
                items.push({ checked: m[1].toLowerCase() === 'x', text: m[2] });
                i += 1;
            }
            blocks.push(
                <ul key={`task-ul-${start}`} className="space-y-1 pl-1">
                    {items.map((item, idx) => (
                        <li key={idx} className="flex items-start gap-2">
                            <input
                                type="checkbox"
                                checked={item.checked}
                                readOnly
                                disabled
                                className="mt-0.5 h-3.5 w-3.5 rounded border-border"
                            />
                            <span>{renderInline(item.text)}</span>
                        </li>
                    ))}
                </ul>
            );
            continue;
        }

        const listMatch = BULLET_LIST_RE.exec(line);
        if (listMatch) {
            const items: string[] = [];
            const start = i;
            while (i < lines.length) {
                const m = BULLET_LIST_RE.exec(lines[i]);
                if (!m) break;
                items.push(m[1]);
                i += 1;
            }
            blocks.push(
                <ul key={`ul-${start}`} className="list-disc pl-5 space-y-1">
                    {items.map((item, idx) => (
                        <li key={idx}>{renderInline(item)}</li>
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
                    {renderInline(text)}
                </p>
            );
        }
    }

    return <div className={cn('space-y-2 whitespace-pre-wrap break-words', className)}>{blocks}</div>;
}
