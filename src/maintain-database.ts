import { loadConfig } from "./config.js";
import { initializeDatabase } from "./database.js";
import { pruneRawEventPayloads } from "./raw-event-retention.js";

const config = loadConfig();
const database = initializeDatabase(config.paths);

try {
  const prunedCount = pruneRawEventPayloads(database, config.history.rawPayloadRetentionMs);
  database.exec("VACUUM");
  console.log(`Pruned ${prunedCount} raw event payloads and compacted ${config.paths.databasePath}`);
} finally {
  database.close();
}
