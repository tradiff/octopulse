import { Profile } from '../src/profile.js';

const [directory, mode] = process.argv.slice(2);
if (!directory) throw new Error('Expected explicit disposable profile');
try {
  const profile = new Profile(directory);
  if (mode === 'crash') process.exit(73);
  profile.close();
} catch {
  process.exitCode = 74;
}
