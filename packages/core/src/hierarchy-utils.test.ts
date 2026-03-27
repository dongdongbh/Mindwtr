import { describe, expect, it } from 'vitest';
import { matchesHierarchicalToken, normalizePrefixedToken } from './hierarchy-utils';

describe('hierarchy utils', () => {
    it('matches exact tokens and slash-delimited descendants', () => {
        expect(matchesHierarchicalToken('@work', '@work')).toBe(true);
        expect(matchesHierarchicalToken('@work', '@work/meetings')).toBe(true);
        expect(matchesHierarchicalToken('#ops', '#ops/oncall')).toBe(true);
    });

    it('does not match siblings or plain prefixes', () => {
        expect(matchesHierarchicalToken('@work', '@home/meetings')).toBe(false);
        expect(matchesHierarchicalToken('@work', '@workshop')).toBe(false);
        expect(matchesHierarchicalToken('#ops', '#operations')).toBe(false);
    });

    it('normalizes missing token prefixes', () => {
        expect(normalizePrefixedToken('work/meetings', '@')).toBe('@work/meetings');
        expect(normalizePrefixedToken('#ops/oncall', '#')).toBe('#ops/oncall');
    });
});
