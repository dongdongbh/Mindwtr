import { forwardRef, type ButtonHTMLAttributes } from 'react';

import { cn } from '../../lib/utils';

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'role'> {
    checked: boolean;
    onCheckedChange?: (checked: boolean) => void;
}

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
    {
        checked,
        onCheckedChange,
        onClick,
        className,
        disabled,
        type = 'button',
        ...props
    },
    ref,
) {
    return (
        <button
            {...props}
            ref={ref}
            type={type}
            role="switch"
            aria-checked={checked}
            disabled={disabled}
            onClick={(event) => {
                onClick?.(event);
                if (!event.defaultPrevented) onCheckedChange?.(!checked);
            }}
            className={cn(
                'relative inline-flex h-[22px] w-10 shrink-0 items-center rounded-full border transition-colors',
                'after:absolute after:inset-x-0 after:-inset-y-[11px] after:content-[\'\']',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                'disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none',


                checked ? 'border-primary bg-primary' : 'border-border bg-muted',
                className,
            )}
        >
            <span
                aria-hidden="true"
                className={cn(
                    'pointer-events-none inline-block h-[18px] w-[18px] rounded-full transition-transform motion-reduce:transition-none',
                    checked
                        ? 'translate-x-[20px] bg-primary-foreground'
                        : 'translate-x-[2px] bg-foreground',
                )}
            />
        </button>
    );
});
