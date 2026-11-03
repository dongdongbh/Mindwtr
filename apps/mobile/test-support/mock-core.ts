


export async function mockCore(
    importOriginal: () => Promise<Record<string, unknown>>,
    getState: () => unknown,
    overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
    const actual = await importOriginal();
    const useTaskStore = Object.assign(
        (selector?: (state: unknown) => unknown) => (
            typeof selector === 'function' ? selector(getState()) : getState()
        ),
        {
            getState,
            setState: (partial: unknown) => Object.assign(
                getState() as Record<string, unknown>,
                typeof partial === 'function'
                    ? (partial as (state: unknown) => Record<string, unknown>)(getState())
                    : partial,
            ),
            subscribe: () => () => {},
        },
    );

    return {
        ...actual,
        useTaskStore,


        shallow: Object.is,
        ...overrides,
    };
}
