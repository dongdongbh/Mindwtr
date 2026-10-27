import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { InboxProjectSection } from './InboxProjectSection';

vi.mock('@/hooks/use-filled-button-colors', () => ({ useFilledButtonColors: () => ({ backgroundColor: '#00f', textColor: '#fff' }) }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('InboxProjectSection project chips', () => {
    it('lists active projects first, then Someday / Waiting after a heading (#1467)', () => {
        const project = (id: string, title: string, status: 'active' | 'someday' | 'waiting') => ({ id, title, status });
        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <InboxProjectSection
                    t={(key) => key}
                    tc={{ text: '#fff', secondaryText: '#aaa', tint: '#00f', filterBg: '#111', cardBg: '#222', border: '#333', inputBg: '#111', onTint: '#fff' } as any}
                    show
                    showProjectField
                    showAreaField={false}
                    setSelectedAreaId={vi.fn()}
                    projectSearch=""
                    setProjectSearch={vi.fn()}
                    convertToProject={false}
                    nextActionDraft=""
                    setNextActionDraft={vi.fn()}
                    extraActionDrafts={[]}
                    setExtraActionDrafts={vi.fn()}
                    filteredProjects={[project('s', 'Someday one', 'someday'), project('a', 'Active one', 'active'), project('w', 'Waiting one', 'waiting')]}
                    areaById={new Map()}
                    hasExactProjectMatch={false}
                    handleCreateProjectEarly={vi.fn()}
                    handleConvertToProject={vi.fn()}
                    selectProjectEarly={vi.fn()}
                />,
            );
        });
        const texts = tree.root.findAll((node) => (node.type as unknown) === 'Text').map((node) => React.Children.toArray(node.props.children).join(''));
        const start = texts.indexOf('Active one');
        expect(texts.slice(start, start + 4)).toEqual(['Active one', 'Someday / Waiting', 'Someday one', 'Waiting one']);
    });
});
