import { createAreaActions } from './store-projects/area-actions';
import { createOrderingActions } from './store-projects/ordering-actions';
import { createProjectCoreActions } from './store-projects/project-actions';
import { createSectionActions } from './store-projects/section-actions';
import type { ProjectActionContext, ProjectActions } from './store-projects/shared';
import { createTaxonomyActions } from './store-projects/taxonomy-actions';

export const createProjectActions = (context: ProjectActionContext): ProjectActions => ({
    ...createProjectCoreActions(context),
    ...createSectionActions(context),
    ...createAreaActions(context),
    ...createOrderingActions(context),
    ...createTaxonomyActions(context),
});
