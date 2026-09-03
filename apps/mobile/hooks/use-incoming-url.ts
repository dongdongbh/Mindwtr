import { useEffect, useState } from 'react';
import * as Linking from 'expo-linking';

import { logInfo } from '@/lib/app-log';

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

// Scheme and host only: a capture link carries the task title in its path/query.
const logIncomingDelivery = (url: string, delivery: number, deduped: boolean): void => {
    let scheme = 'none';
    let host = 'none';
    try {
        const parsed = Linking.parse(url);
        scheme = parsed.scheme ?? 'none';
        host = parsed.hostname ?? 'none';
    } catch {
        // A link the parser rejects is still worth counting.
    }
    void logInfo('Incoming link delivered', {
        scope: 'link',
        extra: {
            releaseCheck: 'v1.2.7/incoming-link-redelivery',
            scheme,
            host,
            delivery: String(delivery),
            deduped: String(deduped),
        },
    });
};

export function useIncomingUrl(): IncomingUrl {
    const [incoming, setIncoming] = useState<IncomingUrl>(INITIAL);

    useEffect(() => {
        let cancelled = false;
        let lastDelivery: { url: string | null; at: number } = { url: null, at: 0 };
        let deliveries = 0;
        Linking.getInitialURL()
            .then((url) => {
                if (cancelled || !url) return;
                lastDelivery = { url, at: Date.now() };
                deliveries += 1;
                logIncomingDelivery(url, deliveries, false);
                setIncoming((previous) => (previous.key === 0 ? { url, key: 1 } : previous));
            })
            .catch(() => undefined);
        const subscription = Linking.addEventListener('url', (event) => {
            const now = Date.now();
            // iOS can deliver the launch URL through the event as well as
            // getInitialURL(); a repeat of the same link within a second is
            // that echo, not a second press.
            if (event.url === lastDelivery.url && now - lastDelivery.at < DUPLICATE_DELIVERY_WINDOW_MS) {
                logIncomingDelivery(event.url, deliveries, true);
                return;
            }
            lastDelivery = { url: event.url, at: now };
            deliveries += 1;
            logIncomingDelivery(event.url, deliveries, false);
            setIncoming((previous) => ({ url: event.url, key: previous.key + 1 }));
        });
        return () => {
            cancelled = true;
            subscription.remove();
        };
    }, []);

    return incoming;
}
