import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
        "PullRequestCiJobState",
        "PullRequestReviewState",
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

  it("applies notification record link migrations", () => {
    const homeDir = createTempDir("octopulse-db-home-");
    const database = initializeDatabase(resolveAppPaths({ homeDir }));

    try {
      expect(readTableColumns(database, "NotificationRecord")).toEqual([
        "id",
        "event_bundle_id",
        "pull_request_id",
        "title",
        "body",
        "delivery_status",
        "created_at",
        "delivered_at",
        "normalized_event_id",
        "click_url",
      ]);
    } finally {
      database.close();
    }
  });

  it("applies event bundle event-range migration", () => {
    const homeDir = createTempDir("octopulse-db-home-");
    const database = initializeDatabase(resolveAppPaths({ homeDir }));

    try {
      expect(readTableColumns(database, "EventBundle")).toEqual([
        "id",
        "pull_request_id",
        "status",
        "first_event_occurred_at",
        "last_event_occurred_at",
        "summary",
        "created_at",
        "sent_at",
      ]);
    } finally {
      database.close();
    }
  });

  it("applies pull request merge-readiness migration", () => {
    const homeDir = createTempDir("octopulse-db-home-");
    const database = initializeDatabase(resolveAppPaths({ homeDir }));

    try {
      expect(readTableColumns(database, "PullRequest")).toEqual(
        expect.arrayContaining([
          "mergeable",
          "mergeable_state",
          "requested_reviewer_logins_json",
          "requested_review_team_keys_json",
          "requested_review_team_slugs_json",
        ]),
      );
    } finally {
      database.close();
    }
  });

  it("applies pull request ci job head sha migration", () => {
    const homeDir = createTempDir("octopulse-db-home-");
    const database = initializeDatabase(resolveAppPaths({ homeDir }));

    try {
      expect(readTableColumns(database, "PullRequestCiJobState")).toEqual(
        expect.arrayContaining(["head_sha"]),
      );
    } finally {
      database.close();
    }
  });

  it("backfills pull request ci job head sha from workflow run raw events", () => {
    const homeDir = createTempDir("octopulse-db-home-");
    const paths = resolveAppPaths({ homeDir });
    const databaseBeforeMigration = initializeDatabase(paths, {
      migrationsPath: createExistingMigrationsDir([
        "0001_initial_schema.sql",
        "0002_pull_request_additional_fields.sql",
        "0003_app_state.sql",
        "0004_normalized_event_notification_timing.sql",
        "0005_normalized_event_bundle_id.sql",
        "0006_notification_record_links.sql",
        "0007_event_bundle_event_range.sql",
        "0008_pull_request_author_avatar_url.sql",
        "0009_pull_request_review_state.sql",
        "0010_pull_request_ci_job_state.sql",
        "0011_pull_request_merge_readiness.sql",
        "0013_pull_request_review_responsibility.sql",
      ]),
    });

    try {
      const result = databaseBeforeMigration
        .prepare(
          `
            INSERT INTO PullRequest (
              github_pull_request_id,
              repository_owner,
              repository_name,
              number,
              url,
              author_login,
              title,
              state,
              is_draft,
              last_seen_at,
              last_seen_head_sha
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          101,
          "acme",
          "octopulse",
          7,
          "https://github.com/acme/octopulse/pull/7",
          "octocat",
          "Add notifications",
          "open",
          0,
          "2026-04-10T12:00:00.000Z",
          "abc123",
        );
      const pullRequestId = Number(result.lastInsertRowid);

      databaseBeforeMigration
        .prepare(
          `
            INSERT INTO RawEvent (
              pull_request_id,
              source,
              source_id,
              event_type,
              actor_login,
              payload_json,
              occurred_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          pullRequestId,
          "github_actions_workflow_run",
          "5001:2026-04-10T12:01:00.000Z",
          "workflow_run",
          "github-actions[bot]",
          JSON.stringify({
            id: 5001,
            head_sha: "abc123",
            name: "Build",
            status: "completed",
            conclusion: "success",
            updated_at: "2026-04-10T12:01:00.000Z",
          }),
          "2026-04-10T12:01:00.000Z",
        );
      databaseBeforeMigration
        .prepare(
          `
            INSERT INTO PullRequestCiJobState (
              pull_request_id,
              workflow_run_id,
              workflow_run_name,
              workflow_run_updated_at,
              job_id,
              job_name,
              job_status,
              job_conclusion,
              is_blocking_merge
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          pullRequestId,
          "5001",
          "Build",
          "2026-04-10T12:01:00.000Z",
          "7001",
          "Artifactory / Promote",
          "completed",
          "success",
          1,
        );
      databaseBeforeMigration
        .prepare("INSERT INTO SchemaMigration (version, name) VALUES (?, ?)")
        .run(14, "cleanup_obsolete_review_request_columns");
    } finally {
      databaseBeforeMigration.close();
    }

    const databaseAfterMigration = initializeDatabase(paths);

    try {
      const row = databaseAfterMigration
        .prepare("SELECT head_sha FROM PullRequestCiJobState WHERE job_id = ?")
        .get("7001") as { head_sha: string | null } | undefined;
      const schemaVersions = databaseAfterMigration
        .prepare("SELECT version FROM SchemaMigration ORDER BY version")
        .all()
        .map((schemaRow) => Number(schemaRow.version));

      expect(row?.head_sha).toBe("abc123");
      expect(schemaVersions).toContain(15);
    } finally {
      databaseAfterMigration.close();
    }
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

function createExistingMigrationsDir(fileNames: string[]): string {
  return createMigrationsDir(
    fileNames.map((fileName) => ({
      name: fileName,
      sql: readFileSync(path.join(process.cwd(), "migrations", fileName), "utf8"),
    })),
  );
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

function readTableColumns(database: ReturnType<typeof initializeDatabase>, tableName: string): string[] {
  return database
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .map((row) => String(row.name));
}
