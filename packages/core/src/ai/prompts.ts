import type { BreakdownInput, ClarifyInput } from './types';

const SYSTEM_PROMPT = [
    'You are a strict GTD coach.',
    'You do not decide for the user; you only clarify and propose options.',
    'Always output valid JSON and nothing else.',
].join(' ');

export function buildClarifyPrompt(input: ClarifyInput): { system: string; user: string } {
    const contexts = (input.contexts || []).filter(Boolean);
    const projectTasks = (input.projectTasks || []).filter(Boolean);
    const payload: Record<string, unknown> = { title: input.title, contexts };
    if (input.projectTitle || projectTasks.length > 0) {
        payload.project = {
            title: input.projectTitle || '',
            tasks: projectTasks,
        };
    }
    const user = [
        'Task:',
        JSON.stringify(payload),
        'Goal: turn this into a concrete next action.',
        'Rules:',
        '1) If vague, ask a single clarifying question.',
        '2) Suggest 2-4 concrete options.',
        '3) Prefer verbs at the start.',
        'Output JSON with:',
        '{ "question": string, "options": [{ "label": string, "action": string }], "suggestedAction"?: { "title": string, "timeEstimate"?: string, "context"?: string, "isProject"?: boolean } }',
    ].join('\n');

    return { system: SYSTEM_PROMPT, user };
}

export function buildBreakdownPrompt(input: BreakdownInput): { system: string; user: string } {
    const projectTasks = (input.projectTasks || []).filter(Boolean);
    const payload: Record<string, unknown> = {
        title: input.title,
        description: input.description || '',
    };
    if (input.projectTitle || projectTasks.length > 0) {
        payload.project = {
            title: input.projectTitle || '',
            tasks: projectTasks,
        };
    }
    const user = [
        'Task:',
        JSON.stringify(payload),
        'Goal: break this into 3-8 actionable next steps.',
        'Output JSON with:',
        '{ "steps": [string] }',
    ].join('\n');

    return { system: SYSTEM_PROMPT, user };
}

export function buildReviewAnalysisPrompt(items: Array<{ id: string; title: string; daysStale: number; status: string }>): { system: string; user: string } {
    const user = [
        'You are a ruthless GTD coach.',
        'Analyze this list of stale items (untouched for >14 days).',
        'For each item, suggest ONE action:',
        '- "someday": move to Someday/Maybe.',
        '- "archive": archive it (likely done or irrelevant).',
        '- "breakdown": too big; needs subtasks.',
        '- "keep": still valid, do nothing.',
        'Return strictly valid JSON:',
        '{ "suggestions": [{ "id": "task_id", "action": "someday|archive|breakdown|keep", "reason": "..." }] }',
        'Items:',
        JSON.stringify(items),
    ].join('\n');

    return { system: SYSTEM_PROMPT, user };
}

export function buildCopilotPrompt(input: { title: string; contexts?: string[]; tags?: string[] }): { system: string; user: string } {
    const contexts = (input.contexts || []).filter(Boolean);
    const tags = (input.tags || []).filter(Boolean);
    const user = [
        'You are a GTD autocomplete engine.',
        'Predict the likely context, tags, and time estimate.',
        'Rules:',
        '- If uncertain, return null values.',
        '- Context must match one from the list or be a standard GTD context (@phone, @computer, @errands, @office, @home).',
        '- Tags must match one from the list or be empty. Use #tag format.',
        '- timeEstimate must be one of: 5min, 10min, 15min, 30min, 1hr, 2hr, 3hr, 4hr, 4hr+.',
        'Output JSON:',
        '{ "context": "@phone", "tags": ["#creative"], "timeEstimate": "15min" }',
        'Task:',
        JSON.stringify({ title: input.title, contexts, tags }),
    ].join('\n');

    return { system: SYSTEM_PROMPT, user };
}
