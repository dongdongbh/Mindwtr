import type { TaskEnergyLevel, TaskPriority, TaskStatus, TimeEstimate } from '@mindwtr/core';

import { cn } from '../../../lib/utils';

function ToggleTokenField({
    ariaLabel,
    label,
    options,
    placeholder,
    value,
    onChange,
}: {
    ariaLabel: string;
    label: string;
    options: string[];
    placeholder: string;
    value: string;
    onChange: (value: string) => void;
}) {
    return (
        <div className="flex flex-col gap-1 w-full">
            <label className="text-xs text-muted-foreground font-medium">{label}</label>
            <input
                type="text"
                aria-label={ariaLabel}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                placeholder={placeholder}
                className="text-xs bg-muted/50 border border-border rounded px-2 py-1 w-full text-foreground placeholder:text-muted-foreground"
            />
            <div className="flex flex-wrap gap-2 pt-1">
                {options.map((token) => {
                    const currentTokens = value.split(',').map((item) => item.trim()).filter(Boolean);
                    const isActive = currentTokens.includes(token);
                    return (
                        <button
                            key={token}
                            type="button"
                            onClick={() => {
                                const nextTokens = isActive
                                    ? currentTokens.filter((item) => item !== token)
                                    : [...currentTokens, token];
                                onChange(nextTokens.join(', '));
                            }}
                            className={cn(
                                'text-[10px] px-2 py-0.5 rounded-full border transition-colors',
                                isActive
                                    ? 'bg-primary/10 border-primary text-primary'
                                    : 'bg-transparent border-border text-muted-foreground hover:border-primary/50'
                            )}
                        >
                            {token}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

export function StatusField({
    t,
    value,
    onChange,
}: {
    t: (key: string) => string;
    value: TaskStatus;
    onChange: (value: TaskStatus) => void;
}) {
    return (
        <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.statusLabel')}</label>
            <select
                value={value}
                aria-label={t('task.aria.status')}
                onChange={(event) => onChange(event.target.value as TaskStatus)}
                className="text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground w-full max-w-[min(18rem,40vw)]"
            >
                <option value="inbox">{t('status.inbox')}</option>
                <option value="next">{t('status.next')}</option>
                <option value="waiting">{t('status.waiting')}</option>
                <option value="someday">{t('status.someday')}</option>
                {value === 'reference' && (
                    <option value="reference">{t('status.reference')}</option>
                )}
                <option value="done">{t('status.done')}</option>
                <option value="archived">{t('status.archived')}</option>
            </select>
        </div>
    );
}

export function PriorityField({
    t,
    value,
    onChange,
}: {
    t: (key: string) => string;
    value: TaskPriority | '';
    onChange: (value: TaskPriority | '') => void;
}) {
    return (
        <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.priorityLabel')}</label>
            <select
                value={value}
                aria-label={t('taskEdit.priorityLabel')}
                onChange={(event) => onChange(event.target.value as TaskPriority | '')}
                className="text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
            >
                <option value="">{t('common.none')}</option>
                <option value="low">{t('priority.low')}</option>
                <option value="medium">{t('priority.medium')}</option>
                <option value="high">{t('priority.high')}</option>
                <option value="urgent">{t('priority.urgent')}</option>
            </select>
        </div>
    );
}

export function EnergyLevelField({
    t,
    value,
    onChange,
}: {
    t: (key: string) => string;
    value: NonNullable<TaskEnergyLevel> | '';
    onChange: (value: NonNullable<TaskEnergyLevel> | '') => void;
}) {
    return (
        <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.energyLevel')}</label>
            <select
                value={value}
                aria-label={t('taskEdit.energyLevel')}
                onChange={(event) => onChange(event.target.value as TaskEnergyLevel | '')}
                className="text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
            >
                <option value="">{t('common.none')}</option>
                <option value="low">{t('energyLevel.low')}</option>
                <option value="medium">{t('energyLevel.medium')}</option>
                <option value="high">{t('energyLevel.high')}</option>
            </select>
        </div>
    );
}

export function AssignedToField({
    t,
    value,
    onChange,
}: {
    t: (key: string) => string;
    value: string;
    onChange: (value: string) => void;
}) {
    return (
        <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.assignedTo')}</label>
            <input
                type="text"
                value={value}
                aria-label={t('taskEdit.assignedTo')}
                onChange={(event) => onChange(event.target.value)}
                placeholder={t('taskEdit.assignedToPlaceholder')}
                className="text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
            />
        </div>
    );
}

export function TimeEstimateField({
    t,
    value,
    onChange,
}: {
    t: (key: string) => string;
    value: TimeEstimate | '';
    onChange: (value: TimeEstimate | '') => void;
}) {
    return (
        <div className="flex flex-col gap-1 w-full">
            <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.timeEstimateLabel')}</label>
            <select
                value={value}
                aria-label={t('task.aria.timeEstimate')}
                onChange={(event) => onChange(event.target.value as TimeEstimate | '')}
                className="text-xs bg-muted/50 border border-border rounded px-2 py-1 w-full text-foreground"
            >
                <option value="">{t('common.none')}</option>
                <option value="5min">5m</option>
                <option value="10min">10m</option>
                <option value="15min">15m</option>
                <option value="30min">30m</option>
                <option value="1hr">1h</option>
                <option value="2hr">2h</option>
                <option value="3hr">3h</option>
                <option value="4hr">4h</option>
                <option value="4hr+">4h+</option>
            </select>
        </div>
    );
}

export function ContextsField({
    t,
    value,
    options,
    onChange,
}: {
    t: (key: string) => string;
    value: string;
    options: string[];
    onChange: (value: string) => void;
}) {
    return (
        <ToggleTokenField
            ariaLabel={t('task.aria.contexts')}
            label={t('taskEdit.contextsLabel')}
            options={options}
            placeholder={t('taskEdit.contextsPlaceholder')}
            value={value}
            onChange={onChange}
        />
    );
}

export function TagsField({
    t,
    value,
    options,
    onChange,
}: {
    t: (key: string) => string;
    value: string;
    options: string[];
    onChange: (value: string) => void;
}) {
    return (
        <ToggleTokenField
            ariaLabel={t('task.aria.tags')}
            label={t('taskEdit.tagsLabel')}
            options={options}
            placeholder={t('taskEdit.tagsPlaceholder')}
            value={value}
            onChange={onChange}
        />
    );
}
