import type { ComponentProps } from 'react';
import { Star } from 'lucide-react';

import { cn } from '../lib/utils';

type FocusStarIconProps = Omit<ComponentProps<typeof Star>, 'fill'> & {
    filled?: boolean;
};


export function FocusStarIcon({ filled = false, className, ...props }: FocusStarIconProps) {
    return (
        <Star
            {...props}
            className={cn(className, filled && 'fill-focus-star text-focus-star-outline')}
            fill={filled ? 'currentColor' : 'none'}
            strokeLinecap="round"
            strokeLinejoin="round"
        />
    );
}
