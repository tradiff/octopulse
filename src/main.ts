import { describeApp } from "./app.js";
import { loadConfig } from "./config.js";
import { initializeDatabase } from "./database.js";

function main(): void {
  try {
    const config = loadConfig();
    const database = initializeDatabase(config.paths);
    database.close();
    console.log(describeApp());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown startup error";
    console.error(`Octopulse failed to start: ${message}`);
    process.exitCode = 1;
  }
}

main();
