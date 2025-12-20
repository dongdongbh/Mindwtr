import React from 'react';
import { FlexWidget, TextWidget } from 'react-native-android-widget';

import type { TasksWidgetPayload } from '../lib/widget-data';

export function buildTasksWidgetTree(payload: TasksWidgetPayload) {
    const { headerTitle, inboxLabel, inboxCount, items, emptyMessage, captureLabel } = payload;
    const children: React.ReactElement[] = [
        React.createElement(TextWidget, {
            key: 'header',
            text: headerTitle,
            style: { color: '#F9FAFB', fontSize: 14, fontWeight: '600' },
        }),
        React.createElement(TextWidget, {
            key: 'inbox',
            text: `${inboxLabel}: ${inboxCount}`,
            style: { color: '#CBD5F5', fontSize: 11, marginTop: 4 },
        }),
    ];

    if (items.length > 0) {
        items.forEach((item, index) => {
            children.push(
                React.createElement(TextWidget, {
                    key: `item-${item.id}`,
                    text: `• ${item.title}`,
                    style: { color: '#F8FAFC', fontSize: 12, marginTop: index === 0 ? 10 : 6 },
                    maxLines: 1,
                    truncate: 'END',
                })
            );
        });
    } else {
        children.push(
            React.createElement(TextWidget, {
                key: 'empty',
                text: emptyMessage,
                style: { color: '#CBD5F5', fontSize: 12, marginTop: 10 },
            })
        );
    }

    children.push(
        React.createElement(TextWidget, {
            key: 'capture',
            text: captureLabel,
            style: {
                color: '#FFFFFF',
                fontSize: 12,
                fontWeight: '600',
                backgroundColor: '#2563EB',
                paddingVertical: 6,
                paddingHorizontal: 10,
                marginTop: 12,
            },
            clickAction: 'OPEN_URI',
            clickActionData: { uri: 'mindwtr://inbox' },
        })
    );

    return React.createElement(
        FlexWidget,
        {
            style: {
                width: 'match_parent',
                height: 'match_parent',
                padding: 12,
                backgroundColor: '#111827',
            },
        },
        ...children
    );
}
