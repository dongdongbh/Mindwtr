# Plan 135 — Encode entity-open URLs in core

Reviewed at `4352275c6`. Desktop and mobile clipboard actions, two widget projections, and the app search projection each choose the route, query key and percent encoding for an entity reference. The search projection additionally accepts a scheme supplied by the client.

## Implementation brief

1. In `packages/core/src/entry-points.test.ts`, round-trip task, project and area identifiers containing slash, percent, spaces and Unicode through the existing parser. Assert the exact outgoing URI for a custom scheme. Run the focused test and observe the missing builder.
2. Add `buildEntityOpenUrl(kind, id, scheme = 'mindwtr')` beside `parseEntityOpenUrl` in `capture-deeplink.ts`. Use the existing `EntityOpenKind`. Replace the five task construction sites in `widget-payload.ts`, `app-search-projection.ts`, desktop `task-clipboard.ts` and mobile `task-reference-clipboard.ts`; migrate the project and area strings in the same search projection.
3. Keep clipboard permission handling and toast presentation in their adapters. Keep the native parsers, Markdown reference format, widget visibility, search filtering and OS scheme registration intact.
4. Run entry-point, app-search, widget and clipboard tests. Existing fixture bytes and copied raw IDs must stay identical. A fixture change indicates a compatibility failure and should stop the refactor.

This change has no migration or dependencies. Future producers should use the same builder for this route.
