import { Component, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isSafeMarkdownExternalHref, normalizeMarkdownInternalLinks, tFallback } from '@mindwtr/core';
import { Copy } from 'lucide-react';

import { useLanguage } from '../contexts/language-context';
import { cn } from '../lib/utils';
import { InternalMarkdownLink, useInternalMarkdownLinkContext } from './InternalMarkdownLink';

const BLANK_LINE_MARKER = '\u00A0';
const BLANK_LINE_CLASS = 'mindwtr-markdown-blank-line';

function transformMarkdownUrl(url: string) {
    const normalized = url.trim().toLowerCase();
    if (
        isSafeMarkdownExternalHref(url)
        || normalized.startsWith('mindwtr://')
        || /^mid:[^\s]+$/i.test(url)
        || normalized.startsWith('#')
    ) {
        return url;
    }
    return '';
}

const extractTextContent = (node: unknown): string => {
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(extractTextContent).join('');
    if (node && typeof node === 'object' && 'props' in node) {
        return extractTextContent((node as { props?: { children?: unknown } }).props?.children);
    }
    return '';
};

function remarkPreserveBlankLines() {
    return (tree: any) => {
        if (!Array.isArray(tree?.children)) return;
        const nextChildren: any[] = [];
        let previousEndLine: number | undefined;

        for (const child of tree.children) {
            const startLine = child?.position?.start?.line;
            if (typeof previousEndLine === 'number' && typeof startLine === 'number') {
                const blankLineCount = Math.max(0, startLine - previousEndLine - 1);
                for (let index = 0; index < blankLineCount; index += 1) {
                    nextChildren.push({
                        type: 'paragraph',
                        data: {
                            hProperties: {
                                className: BLANK_LINE_CLASS,
                                'aria-hidden': 'true',
                            },
                        },
                        children: [{ type: 'text', value: BLANK_LINE_MARKER }],
                    });
                }
            }

            nextChildren.push(child);
            const endLine = child?.position?.end?.line;
            previousEndLine = typeof endLine === 'number'
                ? endLine
                : typeof startLine === 'number'
                    ? startLine
                    : previousEndLine;
        }

        tree.children = nextChildren;
    };
}

function CodeBlock({ children, className, ...props }: any) {
    const { t } = useLanguage();
    const copyCodeLabel = tFallback(t, 'markdown.copyCode', 'Copy code');
    const code = extractTextContent(children).replace(/\n$/, '');
    const handleCopy = () => {
        if (!code || typeof navigator === 'undefined') return;
        void navigator.clipboard?.writeText(code);
    };

    return (
        <div className="group relative my-1">
            <button
                type="button"
                onClick={handleCopy}
                className="absolute right-1.5 top-1.5 rounded border border-border/70 bg-background/90 p-1 text-muted-foreground opacity-0 shadow-sm transition-opacity hover:bg-muted hover:text-foreground focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-primary/30 group-hover:opacity-100"
                aria-label={copyCodeLabel}
                title={copyCodeLabel}
            >
                <Copy className="h-3.5 w-3.5" />
            </button>
            <pre className={cn('bg-muted p-2 pr-9 rounded-md overflow-x-auto', className)} {...props}>
                {children}
            </pre>
        </div>
    );
}

// Markdown parsing runs during render; a bad regex or plugin failure on one
// task's notes must degrade to plain text, not take down the whole view.
class MarkdownFallbackBoundary extends Component<{ markdown: string; children: ReactNode }, { failed: boolean }> {
    state = { failed: false };

    static getDerivedStateFromError() {
        return { failed: true };
    }

    componentDidUpdate(previousProps: { markdown: string }) {
        if (this.state.failed && previousProps.markdown !== this.props.markdown) {
            this.setState({ failed: false });
        }
    }

    render() {
        if (this.state.failed) {
            return <p className="whitespace-pre-wrap leading-relaxed">{this.props.markdown}</p>;
        }
        return this.props.children;
    }
}

export function RichMarkdown({ markdown }: { markdown: string }) {
    const linkContext = useInternalMarkdownLinkContext();

    return (
        <MarkdownFallbackBoundary markdown={markdown || ''}>
        <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkPreserveBlankLines]}
            disallowedElements={['img']}
            urlTransform={transformMarkdownUrl}
            components={{
                h1: ({ className, ...props }: any) => (
                    <h1 className={cn('mt-2 mb-1 text-lg font-semibold leading-snug text-foreground first:mt-0', className)} {...props} />
                ),
                h2: ({ className, ...props }: any) => (
                    <h2 className={cn('mt-2 mb-1 text-base font-semibold leading-snug text-foreground first:mt-0', className)} {...props} />
                ),
                h3: ({ className, ...props }: any) => (
                    <h3 className={cn('mt-1.5 mb-1 text-sm font-semibold leading-snug text-foreground first:mt-0', className)} {...props} />
                ),
                h4: ({ className, ...props }: any) => (
                    <h4 className={cn('mt-1.5 mb-1 text-sm font-medium leading-snug text-foreground first:mt-0', className)} {...props} />
                ),
                a: ({ className, ...props }: any) => (
                    <InternalMarkdownLink
                        href={props.href}
                        className={cn('text-primary underline hover:text-primary/80', className)}
                        linkContext={linkContext}
                    >
                        {props.children}
                    </InternalMarkdownLink>
                ),
                ul: ({ className, ...props }: any) => (
                    <ul className={cn('list-disc pl-4 py-1 space-y-0.5', className)} {...props} />
                ),
                ol: ({ className, ...props }: any) => (
                    <ol className={cn('list-decimal pl-4 py-1 space-y-0.5', className)} {...props} />
                ),
                li: ({ className, ...props }: any) => (
                    <li className={cn('pl-1', className)} {...props} />
                ),
                p: ({ className, children, ...props }: any) => {
                    if (String(className || '').includes(BLANK_LINE_CLASS)) {
                        return (
                            <p
                                className={cn('my-1 h-4 leading-none', className)}
                                aria-hidden="true"
                                {...props}
                            >
                                {BLANK_LINE_MARKER}
                            </p>
                        );
                    }
                    return (
                        <p className={cn('mb-1 last:mb-0 leading-relaxed whitespace-pre-line', className)} {...props}>
                            {children}
                        </p>
                    );
                },
                code: ({ className, ...props }: any) => (
                    <code className={cn('bg-muted px-1 py-0.5 rounded text-[0.9em] font-mono', className)} {...props} />
                ),
                pre: CodeBlock,
                blockquote: ({ className, ...props }: any) => (
                    <blockquote className={cn('border-l-2 border-primary/50 pl-3 italic my-1 text-muted-foreground/80', className)} {...props} />
                ),
                table: ({ className, ...props }: any) => (
                    <div className="overflow-x-auto my-2">
                        <table className={cn('min-w-full divide-y divide-border', className)} {...props} />
                    </div>
                ),
                th: ({ className, ...props }: any) => (
                    <th className={cn('px-2 py-1 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider bg-muted/50', className)} {...props} />
                ),
                td: ({ className, ...props }: any) => (
                    <td className={cn('px-2 py-1 text-sm border-b border-border/50', className)} {...props} />
                ),
                input: ({ type, ...props }: any) => {
                    if (type === 'checkbox') {
                        return <input type="checkbox" className="mr-2 accent-primary" {...props} />;
                    }
                    return <input type={type} {...props} />;
                },
            }}
        >
            {normalizeMarkdownInternalLinks(markdown || '')}
        </ReactMarkdown>
        </MarkdownFallbackBoundary>
    );
}
