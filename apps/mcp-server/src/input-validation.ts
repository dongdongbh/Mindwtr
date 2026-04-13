import { ValidationError } from './errors.js';

export const MAX_TASK_TITLE_LENGTH = 500;
export const MAX_TASK_QUICK_ADD_LENGTH = 2000;
export const MAX_AREA_NAME_LENGTH = 200;
export const MAX_TASK_TOKEN_LENGTH = MAX_TASK_TITLE_LENGTH;

type TaskTokenField = 'contexts' | 'tags';

const TASK_TOKEN_LABELS: Record<TaskTokenField, string> = {
  contexts: 'Context',
  tags: 'Tag',
};

const validateTaskTokenList = (field: TaskTokenField, values: string[]): string[] => {
  const normalized = values.map((value) => value.trim());
  for (const token of normalized) {
    if (!token) {
      throw new ValidationError(`${TASK_TOKEN_LABELS[field]} values must be non-empty strings`);
    }
    if (token.length > MAX_TASK_TOKEN_LENGTH) {
      throw new ValidationError(`${TASK_TOKEN_LABELS[field]} values must be at most ${MAX_TASK_TOKEN_LENGTH} characters`);
    }
  }
  return normalized;
};

export const normalizeOptionalTaskTokens = (
  field: TaskTokenField,
  values: string[] | undefined,
): string[] | undefined => {
  if (values === undefined) return undefined;
  return validateTaskTokenList(field, values);
};

export const normalizeNullableTaskTokens = (
  field: TaskTokenField,
  values: string[] | null | undefined,
): string[] | null | undefined => {
  if (values === undefined || values === null) return values;
  return validateTaskTokenList(field, values);
};
