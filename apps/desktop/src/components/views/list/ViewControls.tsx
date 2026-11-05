import type { SortField, TaskSortBy } from '@mindwtr/core';

import { GroupBySelect } from './GroupBySelect';
import type { TaskGroupAxis } from './next-grouping';
import { SortBySelect } from './list-toolbar';

type ViewControlsProps<Axis extends TaskGroupAxis, Sort extends SortField> = {
    sortBy?: Sort;
    defaultSortBy?: Sort;
    sortByOptions?: readonly Sort[];
    onChangeSortBy?: (value: Sort) => void;
    groupBy?: Axis;
    defaultGroupBy?: Axis;
    groupByOptions?: readonly Axis[];
    groupLabel?: string;
    onChangeGroupBy?: (value: Axis) => void;
    t: (key: string) => string;
};


export function ViewControls<Axis extends TaskGroupAxis, Sort extends SortField = TaskSortBy>({
    sortBy,
    defaultSortBy,
    sortByOptions,
    onChangeSortBy,
    groupBy,
    defaultGroupBy,
    groupByOptions,
    groupLabel,
    onChangeGroupBy,
    t,
}: ViewControlsProps<Axis, Sort>) {
    return (
        <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
            {sortBy !== undefined && onChangeSortBy && (
                <SortBySelect
                    value={sortBy}
                    defaultValue={defaultSortBy}
                    options={sortByOptions}
                    onChange={onChangeSortBy}
                    t={t}
                    className="min-w-0 max-w-full"
                />
            )}
            {groupBy !== undefined && groupByOptions && onChangeGroupBy && (
                <GroupBySelect
                    value={groupBy}
                    defaultValue={defaultGroupBy}
                    axes={groupByOptions}
                    label={groupLabel}
                    onChange={onChangeGroupBy}
                    t={t}
                    className="min-w-0 max-w-full"
                />
            )}
        </div>
    );
}
