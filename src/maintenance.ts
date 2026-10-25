import { isAbsolute } from 'node:path';
import { loadConfig } from './config.js';
import { Profile } from './profile.js';

const args = process.argv.slice(2);
try {
  if (args.length !== 4 || args[0] !== '--config' || args[2] !== '--profile' || !args[1] || !args[3]
    || !isAbsolute(args[1]) || !isAbsolute(args[3])) throw new Error('Usage: maintenance --config /absolute/config.toml --profile /absolute/disposable-profile');
  const config = loadConfig(args[1]);
  const profile = new Profile(args[3]);
  try { profile.store.prune(new Date().toISOString(), config.history.raw_payload_retention); profile.store.reclaim(); }
  finally { profile.close(); }
  console.log('Payload pruning and storage reclamation complete');
} catch (error) {
  console.error(error instanceof Error && error.message.startsWith('Usage:') ? error.message : 'Maintenance failed; check configuration and exclusive profile access');
  process.exitCode = 1;
}
