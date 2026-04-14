import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    Animated,
    Keyboard,
    type LayoutChangeEvent,
    type NativeScrollEvent,
    type NativeSyntheticEvent,
    type ScrollView,
} from 'react-native';

import type { TaskEditTab } from './use-task-edit-state';
import {
    getInitialWindowWidth,
    getTaskEditTabOffset,
    syncTaskEditPagerPosition,
} from './task-edit-modal.utils';

type TaskEditPagerParams = {
    editTab: TaskEditTab;
    isMarkdownOverlayOpen: boolean;
    setEditTab: React.Dispatch<React.SetStateAction<TaskEditTab>>;
    taskId?: string;
    visible: boolean;
};

export function useTaskEditPager({
    editTab,
    isMarkdownOverlayOpen,
    setEditTab,
    taskId,
    visible,
}: TaskEditPagerParams) {
    const [containerWidth, setContainerWidth] = useState(getInitialWindowWidth);
    const scrollX = useRef(new Animated.Value(0)).current;
    const scrollRef = useRef<ScrollView | null>(null);
    const [scrollTaskFormToEnd, setScrollTaskFormToEnd] = useState<((targetInput?: number | string) => void) | null>(null);
    const lastFocusedInputRef = useRef<number | string | undefined>(undefined);
    const pendingScrollTaskFormTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const registerScrollTaskFormToEnd = useCallback((handler: ((targetInput?: number | string) => void) | null) => {
        setScrollTaskFormToEnd(() => handler);
    }, []);

    const scrollToTab = useCallback((mode: TaskEditTab, animated = true) => {
        const node = scrollRef.current as unknown as {
            scrollTo?: (options: { x: number; animated?: boolean }) => void;
            getNode?: () => { scrollTo?: (options: { x: number; animated?: boolean }) => void };
        } | null;
        syncTaskEditPagerPosition({
            mode,
            containerWidth,
            scrollValue: scrollX,
            scrollNode: node,
            animated,
        });
    }, [containerWidth, scrollX]);

    const alignPagerToActiveTab = useCallback(() => {
        if (isMarkdownOverlayOpen) return;
        if (!visible || !containerWidth) return;
        requestAnimationFrame(() => {
            scrollToTab(editTab, false);
        });
    }, [containerWidth, editTab, isMarkdownOverlayOpen, scrollToTab, visible]);

    useEffect(() => {
        if (isMarkdownOverlayOpen) return;
        if (!visible || !containerWidth) return;
        scrollToTab(editTab, false);
    }, [containerWidth, editTab, isMarkdownOverlayOpen, scrollToTab, taskId, visible]);

    useEffect(() => {
        if (isMarkdownOverlayOpen) return;
        if (!visible || !containerWidth) return;
        const alignmentTimer = setTimeout(() => {
            scrollToTab(editTab, false);
        }, 90);
        return () => clearTimeout(alignmentTimer);
    }, [containerWidth, editTab, isMarkdownOverlayOpen, scrollToTab, taskId, visible]);

    useEffect(() => () => {
        if (pendingScrollTaskFormTimerRef.current) {
            clearTimeout(pendingScrollTaskFormTimerRef.current);
            pendingScrollTaskFormTimerRef.current = null;
        }
    }, []);

    useEffect(() => {
        if (isMarkdownOverlayOpen) return;
        if (!visible) return;
        if (typeof Keyboard?.addListener !== 'function') return;

        const handleKeyboardShow = () => {
            alignPagerToActiveTab();
            if (lastFocusedInputRef.current !== undefined) {
                scrollTaskFormToEnd?.(lastFocusedInputRef.current);
            }
        };
        const handleKeyboardHide = () => {
            alignPagerToActiveTab();
        };
        const showListener = Keyboard.addListener('keyboardDidShow', handleKeyboardShow);
        const hideListener = Keyboard.addListener('keyboardDidHide', handleKeyboardHide);
        return () => {
            showListener.remove();
            hideListener.remove();
        };
    }, [alignPagerToActiveTab, isMarkdownOverlayOpen, scrollTaskFormToEnd, visible]);

    const handleInputFocus = useCallback((targetInput?: number | string) => {
        if (pendingScrollTaskFormTimerRef.current) {
            clearTimeout(pendingScrollTaskFormTimerRef.current);
            pendingScrollTaskFormTimerRef.current = null;
        }
        lastFocusedInputRef.current = targetInput;
        if (targetInput === undefined) {
            return;
        }
        pendingScrollTaskFormTimerRef.current = setTimeout(() => {
            scrollTaskFormToEnd?.(targetInput);
            pendingScrollTaskFormTimerRef.current = null;
        }, 140);
    }, [scrollTaskFormToEnd]);

    const handleTabPress = useCallback((mode: TaskEditTab) => {
        setEditTab(mode);
        scrollToTab(mode);
    }, [scrollToTab, setEditTab]);

    const handleContainerLayout = useCallback((event: LayoutChangeEvent) => {
        const nextWidth = Math.round(event.nativeEvent.layout.width);
        if (nextWidth > 0 && nextWidth !== containerWidth) {
            setContainerWidth(nextWidth);
        }
    }, [containerWidth]);

    const handleMomentumScrollEnd = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        if (!containerWidth) return;
        const offsetX = event.nativeEvent.contentOffset.x;
        const target = offsetX >= containerWidth * 0.5 ? 'view' : 'task';
        setEditTab(target);
        const targetX = getTaskEditTabOffset(target, containerWidth);
        if (Math.abs(offsetX - targetX) > 1) {
            scrollToTab(target, false);
        }
    }, [containerWidth, scrollToTab, setEditTab]);

    return {
        containerWidth,
        handleContainerLayout,
        handleInputFocus,
        handleMomentumScrollEnd,
        handleTabPress,
        registerScrollTaskFormToEnd,
        scrollRef,
        scrollX,
    };
}
