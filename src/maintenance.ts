import { isAbsolute } from 'node:path';
import { Settings } from './settings.js';
import { Profile } from './profile.js';

const args = process.argv.slice(2);
try {
  if (args.length !== 2 || args[0] !== '--profile' || !args[1]
    || !isAbsolute(args[1])) throw new Error('Usage: maintenance --profile /absolute/profile');
  const profile = new Profile(args[1]);
  try {
    const settings = new Settings(profile.store, undefined, {});
    profile.store.prune(new Date().toISOString(), settings.effective().history.raw_payload_retention); profile.store.reclaim();
  }
  finally { profile.close(); }
  console.log('Payload pruning and storage reclamation complete');
} catch (error) {
  console.error(error instanceof Error && error.message.startsWith('Usage:') ? error.message : 'Maintenance failed; check settings and exclusive profile access');
  process.exitCode = 1;
}
