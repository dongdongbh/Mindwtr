import type { Area, Project, ProjectAreaGroup, Task } from '@mindwtr/core';

export type ProjectListRow =
  | { type: 'section-label'; key: string; title: string }
  | { type: 'section-toggle'; key: string; title: string; expanded: boolean; sectionKind: 'deferred' | 'archived' }
  | {
      type: 'area-header';
      key: string;
      title: string;
      areaId: string;
      collapsed: boolean;
      sectionKind: 'active' | 'deferred' | 'archived';
      color?: string;
      icon?: string;
    }
  | { type: 'project'; key: string; project: Project; sectionKind: 'active' | 'deferred' | 'archived' };

// Matches core's projectTaskSummaryById value shape (store-types.ts DerivedState);
// core owns the computation (store-helpers.ts computeTaskDerivedState). See #927.
export type ProjectTaskSummary = {
  activeTaskCount: number;
  nextAction?: Task;
};

type BuildProjectListRowsParams = {
  areaById: Map<string, Area>;
  collapsedAreas: Record<string, boolean>;
  groupedActiveProjects: ProjectAreaGroup[];
  groupedArchivedProjects: ProjectAreaGroup[];
  groupedDeferredProjects: ProjectAreaGroup[];
  showArchivedProjects: boolean;
  showDeferredProjects: boolean;
  t: (key: string) => string;
};

function buildAreaRows(
  sectionKind: 'active' | 'deferred' | 'archived',
  groups: ProjectAreaGroup[],
  areaById: Map<string, Area>,
  collapsedAreas: Record<string, boolean>,
  t: (key: string) => string,
): ProjectListRow[] {
  const rows: ProjectListRow[] = [];

  groups.forEach((group) => {
    const areaId = group.areaId ?? 'no-area';
    const area = group.areaId ? areaById.get(group.areaId) : undefined;
    const collapsed = collapsedAreas[areaId] ?? false;

    rows.push({
      type: 'area-header',
      key: `${sectionKind}-area-${areaId}`,
      title: area?.name ?? t('projects.noArea'),
      areaId,
      collapsed,
      sectionKind,
      color: area?.color,
      icon: area?.icon,
    });

    if (collapsed) return;

    group.projects.forEach((project) => {
      rows.push({
        type: 'project',
        key: `${sectionKind}-project-${project.id}`,
        project,
        sectionKind,
      });
    });
  });

  return rows;
}

export function buildProjectListRows({
  areaById,
  collapsedAreas,
  groupedActiveProjects,
  groupedArchivedProjects,
  groupedDeferredProjects,
  showArchivedProjects,
  showDeferredProjects,
  t,
}: BuildProjectListRowsParams): ProjectListRow[] {
  const rows: ProjectListRow[] = [];

  if (groupedActiveProjects.length > 0) {
    rows.push({
      type: 'section-label',
      key: 'active-projects',
      title: t('projects.activeSection'),
    });
    rows.push(...buildAreaRows('active', groupedActiveProjects, areaById, collapsedAreas, t));
  }

  if (groupedDeferredProjects.length > 0) {
    rows.push({
      type: 'section-toggle',
      key: 'deferred-projects',
      title: t('projects.deferredSection'),
      expanded: showDeferredProjects,
      sectionKind: 'deferred',
    });
    if (showDeferredProjects) {
      rows.push(...buildAreaRows('deferred', groupedDeferredProjects, areaById, collapsedAreas, t));
    }
  }

  if (groupedArchivedProjects.length > 0) {
    rows.push({
      type: 'section-toggle',
      key: 'archived-projects',
      title: t('projects.completed'),
      expanded: showArchivedProjects,
      sectionKind: 'archived',
    });
    if (showArchivedProjects) {
      rows.push(...buildAreaRows('archived', groupedArchivedProjects, areaById, collapsedAreas, t));
    }
  }

  return rows;
}
