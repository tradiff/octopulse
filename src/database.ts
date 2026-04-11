import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import type { AppPaths } from "./config.js";

const MIGRATION_FILE_PATTERN = /^(\d+)_([a-z0-9_]+)\.sql$/;
const DEFAULT_MIGRATIONS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

interface Migration {
  version: number;
  name: string;
  fileName: string;
  sql: string;
}

export interface InitializeDatabaseOptions {
  migrationsPath?: string;
}

export class DatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseError";
  }
}

export function initializeDatabase(
  paths: AppPaths,
  options: InitializeDatabaseOptions = {},
): DatabaseSync {
  try {
    mkdirSync(paths.stateDirPath, { recursive: true });
  } catch (error) {
    throw new DatabaseError(
      `Failed to prepare state directory ${paths.stateDirPath}: ${getErrorMessage(error)}`,
    );
  }

  let database: DatabaseSync;

  try {
    database = new DatabaseSync(paths.databasePath);
  } catch (error) {
    throw new DatabaseError(
      `Failed to open database at ${paths.databasePath}: ${getErrorMessage(error)}`,
    );
  }

  try {
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrations(database, options.migrationsPath ?? DEFAULT_MIGRATIONS_PATH);
    return database;
  } catch (error) {
    closeQuietly(database);

    if (error instanceof DatabaseError) {
      throw error;
    }

    throw new DatabaseError(
      `Failed to initialize database at ${paths.databasePath}: ${getErrorMessage(error)}`,
    );
  }
}

export function applyMigrations(
  database: DatabaseSync,
  migrationsPath = DEFAULT_MIGRATIONS_PATH,
): void {
  ensureMigrationTable(database);

  const appliedVersions = readAppliedVersions(database);
  const recordMigration = database.prepare(
    "INSERT INTO SchemaMigration (version, name) VALUES (?, ?)",
  );

  for (const migration of loadMigrations(migrationsPath)) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }

    try {
      database.exec("BEGIN");
      database.exec(migration.sql);
      recordMigration.run(migration.version, migration.name);
      database.exec("COMMIT");
      appliedVersions.add(migration.version);
    } catch (error) {
      rollbackQuietly(database);
      throw new DatabaseError(
        `Failed to apply migration ${migration.fileName}: ${getErrorMessage(error)}`,
      );
    }
  }
}

function ensureMigrationTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS SchemaMigration (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function readAppliedVersions(database: DatabaseSync): Set<number> {
  const rows = database.prepare("SELECT version FROM SchemaMigration ORDER BY version").all();
  const versions = new Set<number>();

  for (const row of rows) {
    versions.add(readInteger(row.version, "SchemaMigration.version"));
  }

  return versions;
}

function loadMigrations(migrationsPath: string): Migration[] {
  let entries;

  try {
    entries = readdirSync(migrationsPath, { withFileTypes: true });
  } catch (error) {
    throw new DatabaseError(
      `Failed to read migrations from ${migrationsPath}: ${getErrorMessage(error)}`,
    );
  }

  const migrations = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => loadMigration(migrationsPath, entry.name))
    .sort((left, right) => left.version - right.version);

  if (migrations.length === 0) {
    throw new DatabaseError(`No SQL migrations found in ${migrationsPath}`);
  }

  const seenVersions = new Set<number>();

  for (const migration of migrations) {
    if (seenVersions.has(migration.version)) {
      throw new DatabaseError(
        `Duplicate migration version ${migration.version} in ${migration.fileName}`,
      );
    }

    seenVersions.add(migration.version);
  }

  return migrations;
}

function loadMigration(migrationsPath: string, fileName: string): Migration {
  const match = fileName.match(MIGRATION_FILE_PATTERN);

  if (!match) {
    throw new DatabaseError(
      `Unsupported migration filename ${fileName}; expected names like 0001_initial_schema.sql`,
    );
  }

  const versionText = match[1];
  const name = match[2];

  if (versionText === undefined || name === undefined) {
    throw new DatabaseError(
      `Unsupported migration filename ${fileName}; expected names like 0001_initial_schema.sql`,
    );
  }

  const sqlPath = path.join(migrationsPath, fileName);
  let sql: string;

  try {
    sql = readFileSync(sqlPath, "utf8");
  } catch (error) {
    throw new DatabaseError(`Failed to read migration ${fileName}: ${getErrorMessage(error)}`);
  }

  if (sql.trim().length === 0) {
    throw new DatabaseError(`Migration ${fileName} is empty`);
  }

  return {
    version: Number.parseInt(versionText, 10),
    name,
    fileName,
    sql,
  };
}

function readInteger(value: unknown, fieldName: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }

  if (typeof value === "bigint") {
    const numericValue = Number(value);

    if (Number.isSafeInteger(numericValue)) {
      return numericValue;
    }
  }

  throw new DatabaseError(`${fieldName} must be a safe integer`);
}

function rollbackQuietly(database: DatabaseSync): void {
  if (!database.isOpen || !database.isTransaction) {
    return;
  }

  try {
    database.exec("ROLLBACK");
  } catch {
    // Preserve the original migration failure.
  }
}

function closeQuietly(database: DatabaseSync): void {
  if (!database.isOpen) {
    return;
  }

  try {
    database.close();
  } catch {
    // Preserve the original initialization failure.
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
