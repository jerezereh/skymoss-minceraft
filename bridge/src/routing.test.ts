/**
 * Tests for CI event routing.
 *
 * The failure mode being guarded is silent: if isUrgentCiEvent returns false for a
 * broken main, the alert goes to a channel that exists specifically to be muted,
 * and the first anyone hears about a broken manifest is a player unable to connect.
 * The reverse is just as corrosive — routing ordinary branch failures as alerts
 * teaches people to ignore the channel, which breaks it just as thoroughly.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isUrgentCiEvent, DEFAULT_BRANCH } from './routing.ts';

describe('isUrgentCiEvent', () => {
  test('a failed build on main is urgent', () => {
    assert.equal(isUrgentCiEvent({ kind: 'ci', status: 'failure', branch: 'main' }), true);
  });

  test('a failed build on a topic branch is not', () => {
    assert.equal(isUrgentCiEvent({ kind: 'ci', status: 'failure', branch: 'feature/sifter' }), false);
  });

  test('a passing build on main is not', () => {
    assert.equal(isUrgentCiEvent({ kind: 'ci', status: 'success', branch: 'main' }), false);
  });

  test('a cancelled build on main is not — cancelling is a human choice, not a break', () => {
    assert.equal(isUrgentCiEvent({ kind: 'ci', status: 'cancelled', branch: 'main' }), false);
  });

  test('an opened pull request is never urgent', () => {
    assert.equal(isUrgentCiEvent({ kind: 'pr', branch: 'feature/sifter' }), false);
  });

  // notify-bridge.sh drops empty fields from the payload, so branch is genuinely
  // absent for releases and for any caller that does not set it. Absent must not
  // be mistaken for main.
  test('a failure with no branch is not urgent', () => {
    assert.equal(isUrgentCiEvent({ kind: 'release', status: 'failure' }), false);
  });

  test('a successful release is not urgent', () => {
    assert.equal(isUrgentCiEvent({ kind: 'release', status: 'success', version: '0.2.0' }), false);
  });

  test('an empty branch string is not treated as main', () => {
    assert.equal(isUrgentCiEvent({ kind: 'ci', status: 'failure', branch: '' }), false);
  });

  test('branch matching is exact, not a prefix', () => {
    assert.equal(isUrgentCiEvent({ kind: 'ci', status: 'failure', branch: 'maintenance' }), false);
    assert.equal(isUrgentCiEvent({ kind: 'ci', status: 'failure', branch: 'main-backup' }), false);
  });

  test('DEFAULT_BRANCH is what the rest of the repo publishes from', () => {
    assert.equal(DEFAULT_BRANCH, 'main');
  });
});
