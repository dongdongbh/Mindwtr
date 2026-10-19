import { createContext } from 'react';

// Submenus keep their view state and event handlers when rendered in the main sidebar.
export const ViewSidebarContext = createContext<HTMLElement | null>(null);
