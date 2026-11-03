import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RichMarkdown } from './RichMarkdown';

vi.mock('react-markdown', () => ({
    default: () => {
        throw new Error('Invalid regular expression: invalid group specifier name');
    },
}));

describe('RichMarkdown fallback', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('falls back to plain text when markdown rendering throws', () => {


        vi.spyOn(console, 'error').mockImplementation(() => {});

        render(<RichMarkdown markdown={'- [ ] buy milk'} />);

        expect(screen.getByText('- [ ] buy milk')).toBeInTheDocument();
    });
});
