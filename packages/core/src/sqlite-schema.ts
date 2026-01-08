export const SQLITE_SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT,
  taskMode TEXT,
  startTime TEXT,
  dueDate TEXT,
  recurrence TEXT,
  pushCount INTEGER,
  tags TEXT,
  contexts TEXT,
  checklist TEXT,
  description TEXT,
  attachments TEXT,
  location TEXT,
  projectId TEXT,
  isFocusedToday INTEGER,
  timeEstimate TEXT,
  reviewAt TEXT,
  completedAt TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  deletedAt TEXT
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
  reviewAt TEXT,
  areaId TEXT,
  areaTitle TEXT,
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
  createdAt TEXT,
  updatedAt TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY
);

INSERT OR IGNORE INTO schema_migrations (version) VALUES (1);

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
  DELETE FROM tasks_fts WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS tasks_au AFTER UPDATE ON tasks BEGIN
  DELETE FROM tasks_fts WHERE id = old.id;
  INSERT INTO tasks_fts (id, title, description, tags, contexts)
  VALUES (new.id, new.title, coalesce(new.description, ''), coalesce(new.tags, ''), coalesce(new.contexts, ''));
END;

CREATE TRIGGER IF NOT EXISTS projects_ai AFTER INSERT ON projects BEGIN
  INSERT INTO projects_fts (id, title, supportNotes, tagIds, areaTitle)
  VALUES (new.id, new.title, coalesce(new.supportNotes, ''), coalesce(new.tagIds, ''), coalesce(new.areaTitle, ''));
END;

CREATE TRIGGER IF NOT EXISTS projects_ad AFTER DELETE ON projects BEGIN
  DELETE FROM projects_fts WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS projects_au AFTER UPDATE ON projects BEGIN
  DELETE FROM projects_fts WHERE id = old.id;
  INSERT INTO projects_fts (id, title, supportNotes, tagIds, areaTitle)
  VALUES (new.id, new.title, coalesce(new.supportNotes, ''), coalesce(new.tagIds, ''), coalesce(new.areaTitle, ''));
END;

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_projectId ON tasks(projectId);
CREATE INDEX IF NOT EXISTS idx_tasks_deletedAt ON tasks(deletedAt);
CREATE INDEX IF NOT EXISTS idx_tasks_dueDate ON tasks(dueDate);
CREATE INDEX IF NOT EXISTS idx_tasks_startTime ON tasks(startTime);
CREATE INDEX IF NOT EXISTS idx_tasks_reviewAt ON tasks(reviewAt);
CREATE INDEX IF NOT EXISTS idx_tasks_createdAt ON tasks(createdAt);
CREATE INDEX IF NOT EXISTS idx_tasks_status_deletedAt ON tasks(status, deletedAt);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status_deletedAt ON tasks(projectId, status, deletedAt);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_areaId ON projects(areaId);
CREATE INDEX IF NOT EXISTS idx_projects_area_order ON projects(areaId, orderNum);
`;
