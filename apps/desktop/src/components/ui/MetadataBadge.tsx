import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';

type MetadataVariant = 'project' | 'context' | 'tag' | 'priority' | 'estimate' | 'age' | 'info';

interface MetadataBadgeProps {
    label: string;
    variant: MetadataVariant;
    icon?: LucideIcon;
    dotColor?: string;
    className?: string;
    ariaLabel?: string;
    title?: string;
}

export function MetadataBadge({ label, variant, icon: Icon, dotColor, className, ariaLabel, title }: MetadataBadgeProps) {
    return (
        <span
            className={cn('metadata-badge', `metadata-badge--${variant}`, className)}
            aria-label={ariaLabel ?? label}
            title={title}
        >
            {dotColor && (
                <span
                    className="metadata-badge__dot"
                    style={{ backgroundColor: dotColor }}
                    aria-hidden="true"
                />
            )}
            {Icon && <Icon className="metadata-badge__icon" aria-hidden="true" />}
            <span className="metadata-badge__label">{label}</span>
        </span>
    );
}
