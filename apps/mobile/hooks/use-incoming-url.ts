import { useEffect, useState } from 'react';
import * as Linking from 'expo-linking';

export type IncomingUrl = {
    url: string | null;
    // Increments on every delivery, so the same link opened twice in a row
    // (an Action Button shortcut that always sends the same capture URL)
    // is handled twice. expo-linking's useURL() only re-renders when the
    // string changes, which made a repeated shortcut capture a no-op.
    key: number;
};

const INITIAL: IncomingUrl = { url: null, key: 0 };
const DUPLICATE_DELIVERY_WINDOW_MS = 1_000;

export function useIncomingUrl(): IncomingUrl {
    const [incoming, setIncoming] = useState<IncomingUrl>(INITIAL);

    useEffect(() => {
        let cancelled = false;
        let lastDelivery: { url: string | null; at: number } = { url: null, at: 0 };
        Linking.getInitialURL()
            .then((url) => {
                if (cancelled || !url) return;
                lastDelivery = { url, at: Date.now() };
                setIncoming((previous) => (previous.key === 0 ? { url, key: 1 } : previous));
            })
            .catch(() => undefined);
        const subscription = Linking.addEventListener('url', (event) => {
            const now = Date.now();
            // iOS can deliver the launch URL through the event as well as
            // getInitialURL(); a repeat of the same link within a second is
            // that echo, not a second press.
            if (event.url === lastDelivery.url && now - lastDelivery.at < DUPLICATE_DELIVERY_WINDOW_MS) return;
            lastDelivery = { url: event.url, at: now };
            setIncoming((previous) => ({ url: event.url, key: previous.key + 1 }));
        });
        return () => {
            cancelled = true;
            subscription.remove();
        };
    }, []);

    return incoming;
}
