import assert from 'node:assert/strict';
import { test } from 'node:test';
import { githubLabel } from '../src/display.js';

test('GitHub labels hide only configured owner prefixes, case-insensitively', () => {
  const owners = ['SonarSource', 'tidelift', 'tradiff'];
  assert.equal(githubLabel('SonarSource/sonar-sca', owners), 'sonar-sca');
  assert.equal(githubLabel('sonarsource/security-sca-squad', owners), 'security-sca-squad');
  assert.equal(githubLabel('TIDELIFT/widget', owners), 'widget');
  assert.equal(githubLabel('tradiff/widget', owners), 'widget');
  assert.equal(githubLabel('other/widget', owners), 'other/widget');
  assert.equal(githubLabel('SonarSource-extra/widget', owners), 'SonarSource-extra/widget');
  assert.equal(githubLabel('SonarSource', owners), 'SonarSource');
  assert.equal(githubLabel('SonarSource/widget', []), 'SonarSource/widget');
});
