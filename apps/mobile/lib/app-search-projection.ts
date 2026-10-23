// The AppSearch projection lives in core (packages/core/src/app-search-projection.ts, pass O2c), shared with the native
// Android app; this module keeps React Native's import path.
export {
    appSearchDocId,
    buildAppSearchDelta,
    buildAreaDoc,
    buildFullAppSearchIndex,
    buildProjectDoc,
    buildTaskDoc,
    isAreaIndexable,
    isProjectIndexable,
    isTaskIndexable,
} from '@mindwtr/core';
export type { AppSearchDelta, AppSearchDoc, AppSearchDocKind } from '@mindwtr/core';
