import { describe, expect, it } from 'vitest';

import { buildTaskUpdatesFromSpeechResult } from './task-utils';

describe('buildTaskUpdatesFromSpeechResult', () => {
    it('maps a smart-parse result into task field updates', () => {
        const plan = buildTaskUpdatesFromSpeechResult(
            {
                title: 'Audio Note Apr 7',
                description: undefined,
                dueDate: undefined,
                startTime: undefined,
                tags: ['#home'],
                contexts: [],
                projectId: undefined,
            },
            {
                transcript: 'Call the electrician tomorrow at 3pm',
                title: 'Call electrician',
                description: 'Ask about the hallway light.',
                dueDate: '2026-04-08T15:00:00.000Z',
                tags: ['urgent'],
                contexts: ['@phone'],
                projectTitle: 'House',
            },
            {
                ai: {
                    speechToText: {
                        mode: 'smart_parse',
                        fieldStrategy: 'smart',
                    },
                },
            },
        );

        expect(plan).toEqual({
            updates: {
                title: 'Call electrician',
                description: 'Ask about the hallway light.',
                dueDate: '2026-04-08T15:00:00.000Z',
                tags: ['#home', '#urgent'],
                contexts: ['@phone'],
            },
            suggestedProjectTitle: 'House',
        });
    });

    it('uses transcript-only field strategy and skips project suggestion when one already exists', () => {
        const plan = buildTaskUpdatesFromSpeechResult(
            {
                title: 'Existing title',
                description: 'Keep me',
                dueDate: undefined,
                startTime: undefined,
                tags: [],
                contexts: ['@work'],
                projectId: 'project-1',
            },
            {
                transcript: 'Draft the launch email and send it by Friday morning',
                projectTitle: 'Ignored',
                contexts: ['desk'],
            },
            {
                ai: {
                    speechToText: {
                        mode: 'transcribe_only',
                        fieldStrategy: 'description_only',
                    },
                },
            },
        );

        expect(plan).toEqual({
            updates: {
                description: 'Draft the launch email and send it by Friday morning',
                contexts: ['@work', '@desk'],
            },
            suggestedProjectTitle: undefined,
        });
    });
});
