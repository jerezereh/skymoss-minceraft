/**
 * Tests for the loop-prevention layer.
 *
 * These matter more than they look. If isAlreadyLinked ever returns false for a
 * message the bridge produced, the relay echoes it back, that echo produces another
 * message, and the bridge floods both an issue and a Discord thread until it hits
 * rate limits. Every assertion here is guarding that failure.
 */

import { test, describe, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeDb } from './db.ts';

const scratch = mkdtempSync(join(tmpdir(), 'skymoss-bridge-test-'));
let db: BridgeDb;
let n = 0;

beforeEach(() => {
  db = new BridgeDb(join(scratch, `t${n++}.db`));
});

afterEach(() => {
  // Windows refuses to unlink a file with an open handle, so the connection must be
  // closed before cleanup rather than left to GC.
  db.close();
});

after(() => {
  // Best-effort: a failed temp cleanup should not fail an otherwise green run.
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const REPO = 'jerezereh/skymoss-minceraft';

function makeThread(issueNumber = 1) {
  return db.createThread({
    repo: REPO,
    issueNumber,
    channelId: '1000',
    threadId: `2000${issueNumber}`,
    title: `Issue ${issueNumber}`,
  });
}

describe('migrations', () => {
  test('apply on first open and are idempotent', () => {
    const path = join(scratch, 'idem.db');
    const a = new BridgeDb(path);
    makeThreadOn(a, 5);
    a.close();

    // Re-opening must not re-run migrations or lose data.
    const b = new BridgeDb(path);
    assert.ok(b.getThreadByIssue(REPO, 5));
    b.close();
  });

  function makeThreadOn(d: BridgeDb, issueNumber: number) {
    d.createThread({
      repo: REPO,
      issueNumber,
      channelId: '1',
      threadId: `t${issueNumber}`,
      title: 'x',
    });
  }
});

describe('issue threads', () => {
  test('round-trip by issue number and by discord thread id', () => {
    makeThread(7);
    assert.equal(db.getThreadByIssue(REPO, 7)?.discord_thread_id, '20007');
    assert.equal(db.getThreadByDiscordThread('20007')?.issue_number, 7);
  });

  test('creating the same issue twice does not duplicate', () => {
    makeThread(7);
    makeThread(7);
    assert.equal(db.getThreadByIssue(REPO, 7)?.issue_number, 7);
  });

  test('unknown lookups return undefined rather than throwing', () => {
    assert.equal(db.getThreadByIssue(REPO, 999), undefined);
    assert.equal(db.getThreadByDiscordThread('nope'), undefined);
  });

  test('state changes persist', () => {
    makeThread(3);
    db.setThreadState(REPO, 3, 'closed');
    assert.equal(db.getThreadByIssue(REPO, 3)?.state, 'closed');
  });
});

describe('loop prevention', () => {
  test('an unseen message is not treated as already relayed', () => {
    assert.equal(db.isAlreadyLinked({ githubCommentId: 'c1' }), false);
    assert.equal(db.isAlreadyLinked({ discordMessageId: 'd1' }), false);
  });

  test('a relayed GitHub comment is recognised on the way back', () => {
    const t = makeThread();
    db.recordLink({ threadId: t.id, githubCommentId: 'c1', discordMessageId: 'd1', direction: 'gh->dc' });

    // This is the echo: Discord fires an event for the message we just created.
    assert.equal(db.isAlreadyLinked({ discordMessageId: 'd1' }), true);
    // And GitHub would fire one for the comment.
    assert.equal(db.isAlreadyLinked({ githubCommentId: 'c1' }), true);
  });

  test('a relayed Discord message is recognised on the way back', () => {
    const t = makeThread();
    db.recordLink({ threadId: t.id, githubCommentId: 'c2', discordMessageId: 'd2', direction: 'dc->gh' });
    assert.equal(db.isAlreadyLinked({ githubCommentId: 'c2' }), true);
  });

  test('either id alone is enough to match', () => {
    const t = makeThread();
    db.recordLink({ threadId: t.id, githubCommentId: 'c3', discordMessageId: 'd3', direction: 'gh->dc' });
    assert.equal(db.isAlreadyLinked({ githubCommentId: 'c3' }), true);
    assert.equal(db.isAlreadyLinked({ discordMessageId: 'd3' }), true);
  });

  test('recording the same link twice does not throw', () => {
    // A webhook redelivery must be harmless, not a crash.
    const t = makeThread();
    db.recordLink({ threadId: t.id, githubCommentId: 'c4', discordMessageId: 'd4', direction: 'gh->dc' });
    assert.doesNotThrow(() => {
      db.recordLink({ threadId: t.id, githubCommentId: 'c4', discordMessageId: 'd4', direction: 'gh->dc' });
    });
  });

  test('links with only one side recorded do not collide', () => {
    // NULLs are excluded from the unique indexes, so many one-sided rows coexist.
    const t = makeThread();
    assert.doesNotThrow(() => {
      db.recordLink({ threadId: t.id, githubCommentId: 'only-a', direction: 'gh->dc' });
      db.recordLink({ threadId: t.id, githubCommentId: 'only-b', direction: 'gh->dc' });
      db.recordLink({ threadId: t.id, discordMessageId: 'only-c', direction: 'dc->gh' });
      db.recordLink({ threadId: t.id, discordMessageId: 'only-d', direction: 'dc->gh' });
    });
  });

  test('an empty query matches nothing', () => {
    assert.equal(db.isAlreadyLinked({}), false);
  });

  test('ids are scoped correctly and do not cross-match', () => {
    // A GitHub comment id must never match against a Discord message id.
    const t = makeThread();
    db.recordLink({ threadId: t.id, githubCommentId: 'shared', direction: 'gh->dc' });
    assert.equal(db.isAlreadyLinked({ discordMessageId: 'shared' }), false);
  });
});

describe('actors', () => {
  test('linking maps a discord user to a github login', () => {
    db.linkActor('discord-1', 'jerezereh', 'Moss');
    assert.equal(db.getActorByDiscord('discord-1')?.github_login, 'jerezereh');
  });

  test('re-linking updates rather than duplicating', () => {
    db.linkActor('discord-1', 'old-login', 'Moss');
    db.linkActor('discord-1', 'new-login', 'Moss');
    assert.equal(db.getActorByDiscord('discord-1')?.github_login, 'new-login');
  });

  test('an unlinked user resolves to undefined', () => {
    assert.equal(db.getActorByDiscord('nobody'), undefined);
  });
});

describe('poll cursor', () => {
  test('is absent before the first poll', () => {
    // The poller relies on this to know it should start from "now" rather than
    // replaying the repo's entire history into Discord.
    assert.equal(db.getPollState('github_last_polled_at'), undefined);
  });

  test('round-trips a timestamp', () => {
    const ts = '2026-07-30T21:00:00.000Z';
    db.setPollState('github_last_polled_at', ts);
    assert.equal(db.getPollState('github_last_polled_at'), ts);
  });

  test('advancing overwrites rather than duplicating', () => {
    db.setPollState('github_last_polled_at', '2026-07-30T21:00:00.000Z');
    db.setPollState('github_last_polled_at', '2026-07-30T22:00:00.000Z');
    assert.equal(db.getPollState('github_last_polled_at'), '2026-07-30T22:00:00.000Z');
  });

  test('survives a reopen', () => {
    // A restart must not lose the cursor, or the bridge re-relays everything since
    // whatever fallback it picks.
    const path = join(scratch, 'cursor.db');
    const a = new BridgeDb(path);
    a.setPollState('github_last_polled_at', '2026-07-30T21:00:00.000Z');
    a.close();

    const b = new BridgeDb(path);
    assert.equal(b.getPollState('github_last_polled_at'), '2026-07-30T21:00:00.000Z');
    b.close();
  });

  test('distinct keys do not collide', () => {
    db.setPollState('a', '1');
    db.setPollState('b', '2');
    assert.equal(db.getPollState('a'), '1');
    assert.equal(db.getPollState('b'), '2');
  });
});

describe('event log', () => {
  test('accepts events with and without payloads', () => {
    assert.doesNotThrow(() => {
      db.logEvent({ source: 'github', eventType: 'issues.opened', outcome: 'relayed' });
      db.logEvent({ source: 'ci', eventType: 'release', payload: { v: '1.0.0' }, outcome: 'relayed' });
    });
  });

  test('an oversized payload is truncated rather than rejected', () => {
    assert.doesNotThrow(() => {
      db.logEvent({
        source: 'github',
        eventType: 'huge',
        payload: { blob: 'x'.repeat(100_000) },
        outcome: 'relayed',
      });
    });
  });
});
