import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveAppPaths } from "../src/config.js";
import { DatabaseError, initializeDatabase } from "../src/database.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("initializeDatabase", () => {
  it("creates the state directory, database file, and initial schema", () => {
    const homeDir = createTempDir("octopulse-db-home-");
    const paths = resolveAppPaths({ homeDir });
    const database = initializeDatabase(paths);

    try {
      expect(existsSync(paths.stateDirPath)).toBe(true);
      expect(existsSync(paths.databasePath)).toBe(true);
      expect(readTableNames(database)).toEqual([
        "AppState",
        "EventBundle",
        "NormalizedEvent",
        "NotificationRecord",
        "PullRequest",
        "RawEvent",
        "SchemaMigration",
      ]);
    } finally {
      database.close();
    }
  });

  it("records applied migrations and skips them on later startups", () => {
    const homeDir = createTempDir("octopulse-db-home-");
    const migrationsPath = createMigrationsDir([
      {
        name: "0001_create_example.sql",
        sql: "CREATE TABLE Example (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL);",
      },
      {
        name: "0002_seed_example.sql",
        sql: "INSERT INTO Example (value) VALUES ('ready');",
      },
    ]);
    const paths = resolveAppPaths({ homeDir });

    const firstDatabase = initializeDatabase(paths, { migrationsPath });

    try {
      expect(readCount(firstDatabase, "SchemaMigration")).toBe(2);
      expect(readCount(firstDatabase, "Example")).toBe(1);
    } finally {
      firstDatabase.close();
    }

    const secondDatabase = initializeDatabase(paths, { migrationsPath });

    try {
      expect(readCount(secondDatabase, "SchemaMigration")).toBe(2);
      expect(readCount(secondDatabase, "Example")).toBe(1);
    } finally {
      secondDatabase.close();
    }
  });

  it("surfaces migration failures with the migration filename", () => {
    const homeDir = createTempDir("octopulse-db-home-");
    const migrationsPath = createMigrationsDir([
      {
        name: "0001_create_example.sql",
        sql: "CREATE TABLE Example (id INTEGER PRIMARY KEY AUTOINCREMENT);",
      },
      {
        name: "0002_bad_sql.sql",
        sql: "INSERT INTO MissingTable VALUES (1);",
      },
    ]);
    const paths = resolveAppPaths({ homeDir });

    expect(() => initializeDatabase(paths, { migrationsPath })).toThrowError(DatabaseError);
    expect(() => initializeDatabase(paths, { migrationsPath })).toThrowError(
      /0002_bad_sql\.sql/,
    );
  });
});

function createTempDir(prefix: string): string {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

function createMigrationsDir(migrations: Array<{ name: string; sql: string }>): string {
  const rootDir = createTempDir("octopulse-migrations-");
  const migrationsPath = path.join(rootDir, "migrations");
  mkdirSync(migrationsPath, { recursive: true });

  for (const migration of migrations) {
    writeFileSync(path.join(migrationsPath, migration.name), `${migration.sql}\n`);
  }

  return migrationsPath;
}

function readTableNames(database: ReturnType<typeof initializeDatabase>): string[] {
  return database
    .prepare(
      [
        "SELECT name",
        "FROM sqlite_master",
        "WHERE type = 'table'",
        "  AND name NOT LIKE 'sqlite_%'",
        "ORDER BY name",
      ].join("\n"),
    )
    .all()
    .map((row) => String(row.name));
}

function readCount(database: ReturnType<typeof initializeDatabase>, tableName: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get();

  if (row?.count === undefined) {
    throw new Error(`Missing count for table ${tableName}`);
  }

  return Number(row.count);
}
