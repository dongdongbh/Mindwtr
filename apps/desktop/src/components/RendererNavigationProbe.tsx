import { useLayoutEffect } from 'react';
import { commitRendererNavigation, type RendererNavigationTrace } from '../lib/renderer-navigation-diagnostics';

export function RendererNavigationProbe({ view, trace }: { view: string; trace: RendererNavigationTrace | null }) {
    useLayoutEffect(() => commitRendererNavigation(view, trace), [view, trace]);
    return null;
}
