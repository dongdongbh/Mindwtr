import { resolveFeatureFlags, tFallback, useTaskStore } from '@mindwtr/core';
import { cn } from '../../../lib/utils';
import { ToolbarSelect } from './ToolbarSelect';
import { getGroupAxisLabel, type TaskGroupAxis } from './next-grouping';

type GroupBySelectProps<Axis extends TaskGroupAxis> = {
    value: Axis;
    axes: readonly Axis[];
    disabledAxes?: readonly Axis[];
    onChange: (value: Axis) => void;
    t: (key: string) => string;
    className?: string;
};

/** The labeled GROUP select shared by every list toolbar. */
export function GroupBySelect<Axis extends TaskGroupAxis>({
    value,
    axes,
    disabledAxes = [],
    onChange,
    t,
    className,
}: GroupBySelectProps<Axis>) {
    const groupLabel = tFallback(t, 'list.groupBy', 'Group');
    // Gated here rather than at each toolbar: Focus, the status lists and
    // Someday all render this select, and a new one must not be able to leak a
    // disabled feature's axis. Callers pass the resolved axis ('priority' reads
    // as 'none' while the feature is off), so dropping the option can never
    // leave the trigger blank (same contract as SortBySelect, #1107).
    const prioritiesEnabled = useTaskStore((state) => resolveFeatureFlags(state.settings).priorities);
    const visibleAxes = prioritiesEnabled ? axes : axes.filter((axis) => axis !== 'priority');
    return (
        <ToolbarSelect
            className={cn('min-w-[180px]', className)}
            label={groupLabel}
            value={value}
            options={visibleAxes.map((axis) => ({
                value: axis,
                label: getGroupAxisLabel(axis, t),
                disabled: disabledAxes.includes(axis),
            }))}
            onChange={(next) => onChange(next as Axis)}
        />
    );
}
