import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const validateSize = size => {
  assert(Number.isSafeInteger(size) && size >= 0, 'Invalid native fixture size');
};

const validateExpectedCapture = expected => {
  assert(isObject(expected), 'Missing expected native capture');
  assert(typeof expected.id === 'string' && expected.id.length > 0, 'Invalid expected capture id');
  assert(typeof expected.title === 'string' && expected.title.length > 0, 'Invalid expected capture title');
};

const validateNativeCaptureState = state => {
  assert(isObject(state), 'Invalid native capture state');
  assert(Number.isSafeInteger(state.taskCount) && state.taskCount >= 0, 'Invalid native task count');
  assert(Array.isArray(state.captures), 'Invalid native capture rows');
  for (const capture of state.captures) {
    assert(isObject(capture), 'Invalid native capture row');
    assert(typeof capture.id === 'string' && capture.id.length > 0, 'Invalid native capture row id');
    assert(typeof capture.title === 'string' && capture.title.length > 0, 'Invalid native capture row title');
    assert(typeof capture.status === 'string' && capture.status.length > 0, 'Invalid native capture row status');
    assert(capture.deletedAt === null || typeof capture.deletedAt === 'string',
      'Invalid native capture deletion state');
  }
  return state;
};

const sqliteString = value => {
  assert(typeof value === 'string' && value.length > 0, 'Invalid native capture title');
  assert(!value.includes('\0'), 'Native capture title contains a null byte');
  return `'${value.replaceAll("'", "''")}'`;
};

export function readNativeCaptureState(database, title) {
  assert(typeof database === 'string' && database.length > 0, 'Invalid native database path');
  const sql = `SELECT json_object(
    'taskCount', (SELECT count(*) FROM tasks),
    'captures', json((SELECT json_group_array(json_object(
      'id', id, 'title', title, 'status', status, 'deletedAt', deletedAt
    )) FROM tasks WHERE title = ${sqliteString(title)}))
  );`;
  const output = execFileSync('sqlite3', [
    '-readonly',
    '-cmd', '.timeout 5000',
    database,
    sql,
  ], { encoding: 'utf8', timeout: 6000 }).trim();
  assert(output.length > 0, 'Missing native capture SQLite result');
  return validateNativeCaptureState(JSON.parse(output));
}

export function validateNativeCaptureBefore(state, size) {
  validateSize(size);
  validateNativeCaptureState(state);
  assert.equal(state.taskCount, size, 'Independent native fixture count mismatch');
  assert.equal(state.captures.length, 0, 'Native capture title already exists');
  return state;
}

export function isNativeCapturePersisted(state, expected, size) {
  validateSize(size);
  validateExpectedCapture(expected);
  validateNativeCaptureState(state);
  if (state.taskCount !== size + 1 || state.captures.length !== 1) return false;
  const [capture] = state.captures;
  return capture.id === expected.id
    && capture.title === expected.title
    && capture.status === 'inbox'
    && capture.deletedAt === null;
}

export function validateNativeCaptureEvidence(evidence, size) {
  assert(isObject(evidence), 'Missing native capture evidence');
  validateExpectedCapture(evidence.expected);
  assert(/^Native benchmark capture \d+$/.test(evidence.expected.title),
    'Invalid synthetic native capture title');
  validateNativeCaptureBefore(evidence.before, size);
  assert(isNativeCapturePersisted(evidence.after, evidence.expected, size),
    'Invalid independent native capture readback');
  assert(isNativeCapturePersisted(evidence.reload, evidence.expected, size),
    'Invalid independent native capture reload readback');
  assert.equal(evidence.reloadVisible, true, 'Capture was not visible after reload');
  return evidence;
}
