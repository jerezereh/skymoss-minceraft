/**
 * Tests for edge-triggered stream alerting.
 *
 * Both failure modes here are invisible from the inside. Alerting on every tick
 * turns #alerts into a channel people mute, which costs the outage it was built for.
 * Never re-arming means the second outage is never announced, and that reads as
 * "quiet" rather than "broken".
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { StreamHealth } from './stream-health.ts';

describe('StreamHealth', () => {
  test('stays quiet below the threshold', () => {
    const h = new StreamHealth(3);
    assert.equal(h.fail('prs').action, 'none');
    assert.equal(h.fail('prs').action, 'none');
  });

  test('alerts exactly on the threshold', () => {
    const h = new StreamHealth(3);
    h.fail('prs');
    h.fail('prs');
    const third = h.fail('prs');
    assert.equal(third.action, 'alert');
    assert.equal(third.count, 3);
  });

  test('does not alert again while it stays broken', () => {
    const h = new StreamHealth(3);
    h.fail('prs');
    h.fail('prs');
    h.fail('prs');
    for (let i = 0; i < 20; i++) {
      assert.equal(h.fail('prs').action, 'none', `tick ${i + 4} re-alerted`);
    }
  });

  test('recovery is announced only after a failure was announced', () => {
    const h = new StreamHealth(3);
    h.fail('prs');
    h.fail('prs');
    h.fail('prs');
    assert.equal(h.succeed('prs'), 'recovered');
  });

  test('a blip below the threshold is silent in both directions', () => {
    const h = new StreamHealth(3);
    h.fail('prs');
    h.fail('prs');
    assert.equal(h.succeed('prs'), 'none');
  });

  test('a success with no prior failure is silent', () => {
    const h = new StreamHealth(3);
    assert.equal(h.succeed('prs'), 'none');
  });

  test('re-arms after recovery, so a second outage is announced', () => {
    const h = new StreamHealth(3);
    for (let i = 0; i < 3; i++) h.fail('prs');
    h.succeed('prs');

    assert.equal(h.fail('prs').action, 'none');
    assert.equal(h.fail('prs').action, 'none');
    assert.equal(h.fail('prs').action, 'alert');
  });

  test('the failure count resets on success rather than accumulating', () => {
    const h = new StreamHealth(3);
    h.fail('prs');
    h.fail('prs');
    h.succeed('prs');
    assert.equal(h.fail('prs').count, 1);
  });

  test('streams are tracked independently', () => {
    const h = new StreamHealth(3);
    for (let i = 0; i < 3; i++) h.fail('prs');

    // A broken PR stream must not consume the releases stream's budget, or one bad
    // token permission would mask an unrelated outage.
    assert.equal(h.fail('releases').action, 'none');
    assert.equal(h.fail('releases').action, 'none');
    assert.equal(h.fail('releases').action, 'alert');
    assert.equal(h.succeed('prs'), 'recovered');
    assert.equal(h.succeed('releases'), 'recovered');
  });

  test('a threshold of 1 alerts on the first failure', () => {
    const h = new StreamHealth(1);
    assert.equal(h.fail('prs').action, 'alert');
    assert.equal(h.fail('prs').action, 'none');
  });
});
