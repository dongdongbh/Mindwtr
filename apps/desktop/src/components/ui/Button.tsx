import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';

export type ButtonVariant =
    | 'primary'
    | 'secondary'
    | 'ghost'
    | 'outline'
    | 'destructive'
    | 'destructive-ghost';

export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: ButtonVariant;
    size?: ButtonSize;
    loading?: boolean;
    fullWidth?: boolean;
    leadingIcon?: ReactNode;
    trailingIcon?: ReactNode;
}

const baseStyles =
    'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ' +
    'disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none ' +
    'whitespace-nowrap';

const variantStyles: Record<ButtonVariant, string> = {
    primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
    secondary: 'bg-muted text-foreground hover:bg-muted/80',
    ghost: 'text-foreground hover:bg-accent hover:text-accent-foreground',
    outline: 'border border-border bg-card text-foreground hover:bg-accent hover:text-accent-foreground',
    destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
    'destructive-ghost': 'text-destructive hover:bg-destructive/10',
};

const sizeStyles: Record<ButtonSize, string> = {
    xs: 'h-7 px-2 text-xs',
    sm: 'h-8 px-2.5 text-xs',
    md: 'h-9 px-3 text-sm',
    lg: 'h-10 px-5 text-sm',
    icon: 'h-9 w-9 p-0',
    'icon-sm': 'h-7 w-7 p-0',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
    {
        className,
        variant = 'primary',
        size = 'md',
        loading = false,
        fullWidth = false,
        leadingIcon,
        trailingIcon,
        children,
        disabled,
        type = 'button',
        ...props
    },
    ref,
) {
    return (
        <button
            ref={ref}
            type={type}
            disabled={disabled || loading}
            aria-busy={loading || undefined}
            className={cn(
                baseStyles,
                variantStyles[variant],
                sizeStyles[size],
                fullWidth && 'w-full',
                className,
            )}
            {...props}
        >
            {loading ? (
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
            ) : (
                leadingIcon
            )}
            {children}
            {!loading && trailingIcon}
        </button>
    );
});
