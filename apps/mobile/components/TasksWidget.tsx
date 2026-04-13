import React from 'react';
import { FlexWidget, TextWidget } from 'react-native-android-widget';

import type { TasksWidgetPayload } from '../lib/widget-data';
import type { AndroidWidgetLayoutMode } from '../lib/widget-layout';

const TASK_ITEM_FONT_SIZE = 13;
const COMPACT_TASK_ITEM_FONT_SIZE = 12;

export function buildTasksWidgetTree(
    payload: TasksWidgetPayload,
    options?: { layoutMode?: AndroidWidgetLayoutMode },
) {
    const { headerTitle, subtitle, items, emptyMessage, captureLabel, focusUri, quickCaptureUri, palette } = payload;
    const layoutMode = options?.layoutMode ?? 'standard';
    const isCompact = layoutMode === 'compact';
    const rootPadding = isCompact ? 10 : 12;
    const taskFontSize = isCompact ? COMPACT_TASK_ITEM_FONT_SIZE : TASK_ITEM_FONT_SIZE;
    const taskMarginTop = isCompact ? 3 : 4;
    const firstTaskMarginTop = isCompact ? 6 : 7;
    const buttonMarginTop = isCompact ? 6 : 8;
    const buttonFontSize = isCompact ? 10 : 11;
    const buttonPaddingVertical = isCompact ? 4 : 5;
    const buttonPaddingHorizontal = isCompact ? 8 : 9;
    const contentChildren: React.ReactElement[] = [
        React.createElement(TextWidget, {
            key: 'header',
            text: headerTitle,
            style: { color: palette.text, fontSize: 13, fontWeight: '600' },
            maxLines: 1,
            truncate: 'END',
            clickAction: 'OPEN_URI',
            clickActionData: { uri: focusUri },
        }),
        React.createElement(TextWidget, {
            key: 'subtitle',
            text: subtitle,
            style: { color: palette.mutedText, fontSize: 10, marginTop: 2 },
            maxLines: 1,
            truncate: 'END',
            clickAction: 'OPEN_URI',
            clickActionData: { uri: focusUri },
        }),
    ];

    if (items.length > 0) {
        items.forEach((item, index) => {
            contentChildren.push(
                React.createElement(TextWidget, {
                    key: `item-${item.id}`,
                    text: `• ${item.title}`,
                    style: {
                        color: palette.text,
                        fontSize: taskFontSize,
                        marginTop: index === 0 ? firstTaskMarginTop : taskMarginTop,
                    },
                    maxLines: 1,
                    truncate: 'END',
                    clickAction: 'OPEN_URI',
                    clickActionData: { uri: focusUri },
                })
            );
        });
    } else {
        contentChildren.push(
            React.createElement(TextWidget, {
                key: 'empty',
                text: emptyMessage,
                style: {
                    color: palette.mutedText,
                    fontSize: 11,
                    marginTop: 7,
                },
                clickAction: 'OPEN_URI',
                clickActionData: { uri: focusUri },
            })
        );
    }

    return React.createElement(
        FlexWidget,
        {
            style: {
                width: 'match_parent',
                height: 'match_parent',
                padding: rootPadding,
                backgroundColor: palette.background,
            },
        },
        React.createElement(
            FlexWidget,
            {
                key: 'content',
                style: {
                    width: 'match_parent',
                },
            },
            ...contentChildren
        ),
        React.createElement(FlexWidget, {
            key: 'spacer',
            style: {
                flex: 1,
            },
        }),
        React.createElement(TextWidget, {
            key: 'capture-bottom',
            text: captureLabel,
            style: {
                color: palette.onAccent,
                fontSize: buttonFontSize,
                fontWeight: '600',
                backgroundColor: palette.accent,
                paddingVertical: buttonPaddingVertical,
                paddingHorizontal: buttonPaddingHorizontal,
                marginTop: buttonMarginTop,
                borderRadius: 999,
                textAlign: 'center',
            },
            clickAction: 'OPEN_URI',
            clickActionData: { uri: quickCaptureUri },
        })
    );
}
