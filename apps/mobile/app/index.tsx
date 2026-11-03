import React, { useEffect, useState } from 'react';
import { Redirect, type Href } from 'expo-router';

import { MOBILE_HOME_ROUTE } from '@/lib/home-route';
import { readRestorableRoute } from '@/lib/session-restore';

export default function Index() {


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


    return <Redirect href={target} withAnchor />;
}
