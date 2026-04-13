import { describe, expect, it } from 'vitest';
import { sanitizeForLog, sanitizeLogContext, sanitizeUrl } from './log-sanitize';

describe('log sanitization', () => {
    it('redacts credentials in plain text', () => {
        expect(sanitizeForLog('Authorization: Bearer secret-token')).toContain('[redacted]');
        expect(sanitizeForLog('password=hunter2')).toContain('password=[redacted]');
    });

    it('redacts private content fields in structured context', () => {
        expect(sanitizeLogContext({
            title: 'Private task title',
            description: 'Very private note',
            projectId: 'project-123',
        })).toEqual({
            title: '[redacted]',
            description: '[redacted]',
            projectId: 'project-123',
        });
    });

    it('redacts ICS urls and query secrets', () => {
        expect(sanitizeUrl('webcal://example.com/calendar.ics')).toBe('[redacted-ics-url]');
        expect(sanitizeUrl('https://example.com/sync?token=secret&ok=1')).toBe('https://example.com/sync?token=redacted&ok=1');
    });
});
