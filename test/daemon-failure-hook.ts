import { Profile } from '../src/profile.js';

globalThis.fetch = async input => new Response(JSON.stringify(String(input).includes('/user/teams') ? [] : { total_count: 0, incomplete_results: false, items: [] }));
if (process.env.OCTOPULSE_TEST_CLOSE_FAILURE === '1') {
  const close = Profile.prototype.close;
  Profile.prototype.close = function () { close.call(this); throw new Error('Synthetic profile-close failure'); };
}
