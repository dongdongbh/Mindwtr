import { sanitizeForLog } from './log-sanitize';

const MAX_BREADCRUMBS = 20;
const breadcrumbs: string[] = [];

export function addBreadcrumb(action: string): void {
    const sanitizedAction = sanitizeForLog(action).trim();
    if (!sanitizedAction) return;
    breadcrumbs.push(`${Date.now()}:${sanitizedAction}`);
    if (breadcrumbs.length > MAX_BREADCRUMBS) {
        breadcrumbs.shift();
    }
}

export function getBreadcrumbs(): string[] {
    return [...breadcrumbs];
}

export function clearBreadcrumbs(): void {
    breadcrumbs.length = 0;
}
