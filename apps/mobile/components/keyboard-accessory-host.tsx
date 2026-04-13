import React from 'react';
import { StyleSheet, View } from 'react-native';

type KeyboardAccessoryHostValue = {
    mount: (key: string, node: React.ReactNode) => void;
    unmount: (key: string) => void;
};

const KeyboardAccessoryHostContext = React.createContext<KeyboardAccessoryHostValue | null>(null);

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    overlay: {
        ...StyleSheet.absoluteFillObject,
    },
});

let nextPortalId = 0;

export function KeyboardAccessoryHost({ children }: { children: React.ReactNode }) {
    const [nodes, setNodes] = React.useState<Array<{ key: string; node: React.ReactNode }>>([]);

    const mount = React.useCallback((key: string, node: React.ReactNode) => {
        setNodes((current) => {
            const index = current.findIndex((entry) => entry.key === key);
            if (index === -1) {
                return [...current, { key, node }];
            }
            const next = [...current];
            next[index] = { key, node };
            return next;
        });
    }, []);

    const unmount = React.useCallback((key: string) => {
        setNodes((current) => current.filter((entry) => entry.key !== key));
    }, []);

    const value = React.useMemo(() => ({ mount, unmount }), [mount, unmount]);

    return (
        <KeyboardAccessoryHostContext.Provider value={value}>
            <View style={styles.container}>
                {children}
                <View pointerEvents="box-none" style={styles.overlay}>
                    {nodes.map((entry) => (
                        <React.Fragment key={entry.key}>{entry.node}</React.Fragment>
                    ))}
                </View>
            </View>
        </KeyboardAccessoryHostContext.Provider>
    );
}

export function KeyboardAccessoryPortal({ children }: { children: React.ReactNode }) {
    const host = React.useContext(KeyboardAccessoryHostContext);
    const portalKeyRef = React.useRef(`keyboard-accessory-${nextPortalId++}`);

    React.useEffect(() => {
        if (!host) return;
        host.mount(portalKeyRef.current, children);
        return () => host.unmount(portalKeyRef.current);
    }, [children, host]);

    if (host) {
        return null;
    }

    return <>{children}</>;
}
