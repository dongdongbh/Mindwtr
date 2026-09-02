import React, { useEffect, useState } from 'react';
import { Redirect, type Href } from 'expo-router';

import { MOBILE_HOME_ROUTE } from '@/lib/home-route';
import { readRestorableRoute } from '@/lib/session-restore';

export default function Index() {
    // Reopening shortly after the app closed resumes the interrupted session on
    // the same screen; a fresh session starts on Focus (#842). Deep links,
    // notifications, and share intents bypass this route entirely.
    const [target, setTarget] = useState<Href | null>(null);

    useEffect(() => {
        let cancelled = false;
        readRestorableRoute()
            .then((snapshot) => {
                if (cancelled) return;
                setTarget(snapshot
                    ? { pathname: snapshot.pathname, params: snapshot.params ?? {} } as Href
                    : MOBILE_HOME_ROUTE);
            })
            .catch(() => {
                if (!cancelled) setTarget(MOBILE_HOME_ROUTE);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    if (!target) return null;
    // withAnchor keeps the tabs underneath a restored stack screen, so the
    // header back button and Android system back return into the app instead
    // of closing it (#842).
    return <Redirect href={target} withAnchor />;
}
