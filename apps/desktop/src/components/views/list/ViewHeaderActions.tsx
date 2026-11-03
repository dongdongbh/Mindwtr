import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';


export const ViewHeaderActionsTarget = createContext<HTMLElement | null>(null);

export function ViewHeaderActions({ children }: { children: ReactNode }) {
    const target = useContext(ViewHeaderActionsTarget);
    return target ? createPortal(children, target) : children;
}
