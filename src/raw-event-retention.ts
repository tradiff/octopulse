import { DatabaseSync } from "node:sqlite";

export const DEFAULT_RAW_EVENT_PAYLOAD_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const PRUNED_RAW_EVENT_PAYLOAD_JSON = '{"octopulse_payload_pruned":true}';

export function pruneRawEventPayloads(
  database: DatabaseSync,
  retentionMs: number,
  now = new Date().toISOString(),
): number {
  if (!Number.isFinite(retentionMs) || retentionMs <= 0) {
    throw new Error("Raw event payload retention must be greater than zero");
  }

  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) {
    throw new Error("Raw event payload pruning requires a valid current timestamp");
  }

  const result = database
    .prepare(
      `
        UPDATE RawEvent
        SET payload_json = CASE event_type
          WHEN 'workflow_run' THEN json_object(
            '_octopulse_compacted', 1,
            'id', json_extract(payload_json, '$.id'),
            'node_id', json_extract(payload_json, '$.node_id'),
            'head_sha', json_extract(payload_json, '$.head_sha'),
            'status', json_extract(payload_json, '$.status'),
            'conclusion', json_extract(payload_json, '$.conclusion'),
            'name', json_extract(payload_json, '$.name'),
            'html_url', json_extract(payload_json, '$.html_url'),
            'actor', json_object(
              'type', json_extract(payload_json, '$.actor.type'),
              'avatar_url', json_extract(payload_json, '$.actor.avatar_url')
            )
          )
          ELSE ?
        END
        WHERE occurred_at < ?
          AND payload_json <> ?
          AND (
            event_type <> 'workflow_run'
            OR json_extract(payload_json, '$._octopulse_compacted') IS NULL
          )
      `,
    )
    .run(
      PRUNED_RAW_EVENT_PAYLOAD_JSON,
      new Date(nowMs - retentionMs).toISOString(),
      PRUNED_RAW_EVENT_PAYLOAD_JSON,
    );

  return Number(result.changes);
}
