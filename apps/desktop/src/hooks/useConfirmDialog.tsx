import { useCallback, useEffect, useRef, useState } from 'react';

import { ConfirmModal } from '../components/ConfirmModal';

export type ConfirmationRequestOptions = {
    title: string;
    description?: string;
    confirmLabel: string;
    cancelLabel: string;
};

type PendingConfirmation = ConfirmationRequestOptions & {
    resolve: (confirmed: boolean) => void;
};

export function useConfirmDialog() {
    const pendingRef = useRef<PendingConfirmation | null>(null);
    const [pending, setPending] = useState<PendingConfirmation | null>(null);

    const settle = useCallback((confirmed: boolean) => {
        const current = pendingRef.current;
        if (!current) return;
        pendingRef.current = null;
        setPending(null);
        current.resolve(confirmed);
    }, []);

    useEffect(() => {
        return () => {
            if (!pendingRef.current) return;
            const current = pendingRef.current;
            pendingRef.current = null;
            current.resolve(false);
        };
    }, []);

    const requestConfirmation = useCallback((options: ConfirmationRequestOptions) => {
        return new Promise<boolean>((resolve) => {
            pendingRef.current?.resolve(false);
            const next: PendingConfirmation = { ...options, resolve };
            pendingRef.current = next;
            setPending(next);
        });
    }, []);

    const confirmModal = (
        <ConfirmModal
            isOpen={pending !== null}
            title={pending?.title ?? ''}
            description={pending?.description}
            confirmLabel={pending?.confirmLabel ?? 'Confirm'}
            cancelLabel={pending?.cancelLabel ?? 'Cancel'}
            onCancel={() => settle(false)}
            onConfirm={() => settle(true)}
        />
    );

    return {
        requestConfirmation,
        confirmModal,
        hasPendingConfirmation: pending !== null,
    };
}
