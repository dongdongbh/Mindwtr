export type MindwtrToolErrorCode = 'read_only' | 'not_found' | 'validation_error' | 'task_version_conflict' | 'idempotency_conflict' | 'idempotency_capacity' | 'internal_error';

export class MindwtrToolError extends Error {
  readonly code: MindwtrToolErrorCode;

  constructor(message: string, code: MindwtrToolErrorCode) {
    super(message);
    this.name = 'MindwtrToolError';
    this.code = code;
  }
}

export class ReadOnlyError extends MindwtrToolError {
  constructor(message = 'Database opened read-only. Start the server with --write to enable edits.') {
    super(message, 'read_only');
    this.name = 'ReadOnlyError';
  }
}

export class NotFoundError extends MindwtrToolError {
  constructor(message: string) {
    super(message, 'not_found');
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends MindwtrToolError {
  constructor(message: string) {
    super(message, 'validation_error');
    this.name = 'ValidationError';
  }
}

export const getMindwtrToolErrorCode = (error: unknown): MindwtrToolErrorCode =>
  error instanceof MindwtrToolError ? error.code : 'internal_error';
