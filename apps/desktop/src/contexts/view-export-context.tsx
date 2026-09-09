import {
    createContext,
    type ReactNode,
    useCallback,
    useContext,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import type { Task } from '@mindwtr/core';

type Registration = {
    owner: symbol;
    scope: symbol;
    tasks: readonly Task[] | null;
};

type RegisterViewExportTasks = (
    scope: symbol,
    tasks: readonly Task[] | null,
) => () => void;

type RegistrationContextValue = {
    register: RegisterViewExportTasks;
    scope: symbol;
};

const RegisterViewExportContext = createContext<RegistrationContextValue | null>(null);
const ViewExportContext = createContext<{ tasks: readonly Task[] | null }>({ tasks: null });

export function ViewExportProvider({
    viewKey,
    children,
}: {
    viewKey: string;
    children: ReactNode;
}) {
    const [routeScope, setRouteScope] = useState(() => ({
        viewKey,
        token: Symbol('view-export-route'),
    }));
    const [registration, setRegistration] = useState<Registration | null>(null);

    // Route matching happens during render, so consumers cannot observe the
    // previous view's tasks for even one committed frame. The registration
    // callback remains stable: a retained source with unchanged results must
    // not accidentally register itself for a newly selected route. A fresh
    // token per transition means A -> B -> A cannot resurrect A's old data.
    if (routeScope.viewKey !== viewKey) {
        setRouteScope({ viewKey, token: Symbol('view-export-route') });
    }

    const register = useCallback<RegisterViewExportTasks>((scope, tasks) => {
        const owner = Symbol('view-export-registration');
        setRegistration({ owner, scope, tasks });

        return () => {
            setRegistration((current) => (
                current?.owner === owner ? null : current
            ));
        };
    }, []);

    const registrationContext = useMemo(() => ({
        register,
        scope: routeScope.token,
    }), [register, routeScope.token]);
    const tasks = routeScope.viewKey === viewKey && registration?.scope === routeScope.token
        ? registration.tasks
        : null;
    const exportState = useMemo(() => ({ tasks }), [tasks]);

    return (
        <RegisterViewExportContext.Provider value={registrationContext}>
            <ViewExportContext.Provider value={exportState}>
                {children}
            </ViewExportContext.Provider>
        </RegisterViewExportContext.Provider>
    );
}

export function useViewExportTasks(tasks: readonly Task[] | null): void {
    const registrationContext = useContext(RegisterViewExportContext);
    const register = registrationContext?.register ?? null;
    const scope = registrationContext?.scope ?? null;
    const scopeRef = useRef(scope);
    scopeRef.current = scope;

    useLayoutEffect(() => {
        if (!register) return undefined;
        const currentScope = scopeRef.current;
        if (!currentScope) return undefined;
        return register(currentScope, tasks);
    }, [register, tasks]);
}

export function useViewExport(): { tasks: readonly Task[] | null } {
    return useContext(ViewExportContext);
}
