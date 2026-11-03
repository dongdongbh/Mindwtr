import { fireEvent, screen, type ByRoleMatcher, type ByRoleOptions } from '@testing-library/react';


type ScopedQueries = {
    getByRole: (role: ByRoleMatcher, options?: ByRoleOptions) => HTMLElement;
};


export function openToolbarSelect(name: string, scope: ScopedQueries = screen): HTMLElement {
    const trigger = scope.getByRole('combobox', { name });
    fireEvent.click(trigger);
    return trigger;
}


export function selectToolbarOption(name: string, optionName: string | RegExp, scope: ScopedQueries = screen): void {
    openToolbarSelect(name, scope);
    const option = screen.getByRole('option', { name: optionName });
    fireEvent.click(option);
}
