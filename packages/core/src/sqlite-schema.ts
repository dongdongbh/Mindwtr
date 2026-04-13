export const SQLITE_SCHEMA_VERSION = 2;

export const SQLITE_BASE_SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT,
  energyLevel TEXT,
  assignedTo TEXT,
  taskMode TEXT,
  startTime TEXT,
  dueDate TEXT,
  recurrence TEXT,
  pushCount INTEGER,
  tags TEXT,
  contexts TEXT,
  checklist TEXT,
  description TEXT,
  textDirection TEXT,
  attachments TEXT,
  location TEXT,
  projectId TEXT REFERENCES projects(id) ON DELETE SET NULL,
  sectionId TEXT REFERENCES sections(id) ON DELETE SET NULL,
  areaId TEXT REFERENCES areas(id) ON DELETE SET NULL,
  orderNum INTEGER,
  isFocusedToday INTEGER,
  timeEstimate TEXT,
  reviewAt TEXT,
  completedAt TEXT,
  rev INTEGER,
  revBy TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  deletedAt TEXT,
  purgedAt TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  color TEXT NOT NULL,
  orderNum INTEGER,
  tagIds TEXT,
  isSequential INTEGER,
  isFocused INTEGER,
  supportNotes TEXT,
  attachments TEXT,
  dueDate TEXT,
  reviewAt TEXT,
  areaId TEXT REFERENCES areas(id) ON DELETE SET NULL,
  areaTitle TEXT,
  rev INTEGER,
  revBy TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  deletedAt TEXT
);

CREATE TABLE IF NOT EXISTS areas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT,
  icon TEXT,
  orderNum INTEGER NOT NULL,
  rev INTEGER,
  revBy TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  deletedAt TEXT
);

CREATE TABLE IF NOT EXISTS sections (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  orderNum INTEGER,
  isCollapsed INTEGER,
  rev INTEGER,
  revBy TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  deletedAt TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY
);

INSERT OR IGNORE INTO schema_migrations (version) VALUES (1);

CREATE TRIGGER IF NOT EXISTS tasks_validate_insert
BEFORE INSERT ON tasks
BEGIN
  SELECT RAISE(ABORT, 'invalid_task_status')
  WHERE new.status NOT IN ('inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived');
  SELECT RAISE(ABORT, 'invalid_tasks_tags_json')
  WHERE new.tags IS NOT NULL AND json_valid(new.tags) = 0;
  SELECT RAISE(ABORT, 'invalid_tasks_contexts_json')
  WHERE new.contexts IS NOT NULL AND json_valid(new.contexts) = 0;
  SELECT RAISE(ABORT, 'invalid_tasks_checklist_json')
  WHERE new.checklist IS NOT NULL AND json_valid(new.checklist) = 0;
  SELECT RAISE(ABORT, 'invalid_tasks_attachments_json')
  WHERE new.attachments IS NOT NULL AND json_valid(new.attachments) = 0;
  SELECT RAISE(ABORT, 'invalid_tasks_recurrence_json')
  WHERE new.recurrence IS NOT NULL AND json_valid(new.recurrence) = 0;
END;

CREATE TRIGGER IF NOT EXISTS tasks_validate_update
BEFORE UPDATE ON tasks
BEGIN
  SELECT RAISE(ABORT, 'invalid_task_status')
  WHERE new.status NOT IN ('inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived');
  SELECT RAISE(ABORT, 'invalid_tasks_tags_json')
  WHERE new.tags IS NOT NULL AND json_valid(new.tags) = 0;
  SELECT RAISE(ABORT, 'invalid_tasks_contexts_json')
  WHERE new.contexts IS NOT NULL AND json_valid(new.contexts) = 0;
  SELECT RAISE(ABORT, 'invalid_tasks_checklist_json')
  WHERE new.checklist IS NOT NULL AND json_valid(new.checklist) = 0;
  SELECT RAISE(ABORT, 'invalid_tasks_attachments_json')
  WHERE new.attachments IS NOT NULL AND json_valid(new.attachments) = 0;
  SELECT RAISE(ABORT, 'invalid_tasks_recurrence_json')
  WHERE new.recurrence IS NOT NULL AND json_valid(new.recurrence) = 0;
END;

CREATE TRIGGER IF NOT EXISTS projects_validate_insert
BEFORE INSERT ON projects
BEGIN
  SELECT RAISE(ABORT, 'invalid_project_status')
  WHERE new.status NOT IN ('active', 'someday', 'waiting', 'archived');
  SELECT RAISE(ABORT, 'invalid_projects_tag_ids_json')
  WHERE new.tagIds IS NOT NULL AND json_valid(new.tagIds) = 0;
  SELECT RAISE(ABORT, 'invalid_projects_attachments_json')
  WHERE new.attachments IS NOT NULL AND json_valid(new.attachments) = 0;
END;

CREATE TRIGGER IF NOT EXISTS projects_validate_update
BEFORE UPDATE ON projects
BEGIN
  SELECT RAISE(ABORT, 'invalid_project_status')
  WHERE new.status NOT IN ('active', 'someday', 'waiting', 'archived');
  SELECT RAISE(ABORT, 'invalid_projects_tag_ids_json')
  WHERE new.tagIds IS NOT NULL AND json_valid(new.tagIds) = 0;
  SELECT RAISE(ABORT, 'invalid_projects_attachments_json')
  WHERE new.attachments IS NOT NULL AND json_valid(new.attachments) = 0;
END;

`;

export const SQLITE_INDEX_SCHEMA = `
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_projectId ON tasks(projectId);
CREATE INDEX IF NOT EXISTS idx_tasks_deletedAt ON tasks(deletedAt);
CREATE INDEX IF NOT EXISTS idx_tasks_dueDate ON tasks(dueDate);
CREATE INDEX IF NOT EXISTS idx_tasks_startTime ON tasks(startTime);
CREATE INDEX IF NOT EXISTS idx_tasks_reviewAt ON tasks(reviewAt);
CREATE INDEX IF NOT EXISTS idx_tasks_completedAt ON tasks(completedAt);
CREATE INDEX IF NOT EXISTS idx_tasks_createdAt ON tasks(createdAt);
CREATE INDEX IF NOT EXISTS idx_tasks_updatedAt ON tasks(updatedAt);
CREATE INDEX IF NOT EXISTS idx_tasks_updatedAt_deletedAt ON tasks(updatedAt, deletedAt);
CREATE INDEX IF NOT EXISTS idx_tasks_status_deletedAt ON tasks(status, deletedAt);
CREATE INDEX IF NOT EXISTS idx_tasks_project_deletedAt ON tasks(projectId, deletedAt);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status_deletedAt ON tasks(projectId, status, deletedAt);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status_updatedAt ON tasks(projectId, status, updatedAt);
CREATE INDEX IF NOT EXISTS idx_tasks_projectId_orderNum ON tasks(projectId, orderNum);
CREATE INDEX IF NOT EXISTS idx_tasks_area_deletedAt ON tasks(areaId, deletedAt);
CREATE INDEX IF NOT EXISTS idx_tasks_area_id ON tasks(areaId);
CREATE INDEX IF NOT EXISTS idx_tasks_section_id ON tasks(sectionId);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_areaId ON projects(areaId);
CREATE INDEX IF NOT EXISTS idx_projects_area_order ON projects(areaId, orderNum);
CREATE INDEX IF NOT EXISTS idx_projects_dueDate ON projects(dueDate);
`;

export const SQLITE_FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
  id UNINDEXED,
  title,
  description,
  tags,
  contexts,
  content=''
);

CREATE VIRTUAL TABLE IF NOT EXISTS projects_fts USING fts5(
  id UNINDEXED,
  title,
  supportNotes,
  tagIds,
  areaTitle,
  content=''
);

CREATE TRIGGER IF NOT EXISTS tasks_ai AFTER INSERT ON tasks BEGIN
  INSERT INTO tasks_fts (id, title, description, tags, contexts)
  VALUES (new.id, new.title, coalesce(new.description, ''), coalesce(new.tags, ''), coalesce(new.contexts, ''));
END;

CREATE TRIGGER IF NOT EXISTS tasks_ad AFTER DELETE ON tasks BEGIN
  INSERT INTO tasks_fts (tasks_fts, id, title, description, tags, contexts)
  VALUES ('delete', old.id, old.title, coalesce(old.description, ''), coalesce(old.tags, ''), coalesce(old.contexts, ''));
END;

CREATE TRIGGER IF NOT EXISTS tasks_au AFTER UPDATE ON tasks BEGIN
  INSERT INTO tasks_fts (tasks_fts, id, title, description, tags, contexts)
  VALUES ('delete', old.id, old.title, coalesce(old.description, ''), coalesce(old.tags, ''), coalesce(old.contexts, ''));
  INSERT INTO tasks_fts (id, title, description, tags, contexts)
  VALUES (new.id, new.title, coalesce(new.description, ''), coalesce(new.tags, ''), coalesce(new.contexts, ''));
END;

CREATE TRIGGER IF NOT EXISTS projects_ai AFTER INSERT ON projects BEGIN
  INSERT INTO projects_fts (id, title, supportNotes, tagIds, areaTitle)
  VALUES (new.id, new.title, coalesce(new.supportNotes, ''), coalesce(new.tagIds, ''), coalesce(new.areaTitle, ''));
END;

CREATE TRIGGER IF NOT EXISTS projects_ad AFTER DELETE ON projects BEGIN
  INSERT INTO projects_fts (projects_fts, id, title, supportNotes, tagIds, areaTitle)
  VALUES ('delete', old.id, old.title, coalesce(old.supportNotes, ''), coalesce(old.tagIds, ''), coalesce(old.areaTitle, ''));
END;

CREATE TRIGGER IF NOT EXISTS projects_au AFTER UPDATE ON projects BEGIN
  INSERT INTO projects_fts (projects_fts, id, title, supportNotes, tagIds, areaTitle)
  VALUES ('delete', old.id, old.title, coalesce(old.supportNotes, ''), coalesce(old.tagIds, ''), coalesce(old.areaTitle, ''));
  INSERT INTO projects_fts (id, title, supportNotes, tagIds, areaTitle)
  VALUES (new.id, new.title, coalesce(new.supportNotes, ''), coalesce(new.tagIds, ''), coalesce(new.areaTitle, ''));
END;
`;

export const SQLITE_SCHEMA = `${SQLITE_BASE_SCHEMA}\n${SQLITE_FTS_SCHEMA}`;
