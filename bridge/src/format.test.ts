import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  bugReportToGithub,
  discordToGithub,
  githubToDiscord,
  isRelayedComment,
  parseBugReport,
  truncateForDiscord,
  threadName,
  RELAY_MARKER,
} from './format.ts';

describe('relay marker', () => {
  test('a comment the bridge produced is recognised as relayed', () => {
    const body = discordToGithub({ displayName: 'moss', content: 'hello' });
    assert.ok(isRelayedComment(body));
  });

  test('an ordinary human comment is not', () => {
    assert.equal(isRelayedComment('just a normal comment'), false);
  });

  test('the marker is stripped when coming back the other way', () => {
    const relayed = discordToGithub({ displayName: 'moss', content: 'hello' });
    assert.ok(!githubToDiscord(relayed).includes(RELAY_MARKER));
  });
});

describe('discordToGithub', () => {
  test('prefers a linked GitHub login over the Discord display name', () => {
    const body = discordToGithub({ displayName: 'MossFan', githubLogin: 'jerezereh', content: 'hi' });
    assert.ok(body.includes('@jerezereh'));
  });

  test('falls back to display name when unlinked', () => {
    const body = discordToGithub({ displayName: 'MossFan', content: 'hi' });
    assert.ok(body.includes('MossFan'));
  });

  test('an empty message still produces a valid comment body', () => {
    // Discord allows an attachment-only message; GitHub rejects an empty comment.
    const body = discordToGithub({
      displayName: 'moss',
      content: '',
      attachments: [{ name: 'crash.txt', url: 'https://cdn.discord/crash.txt' }],
    });
    assert.ok(body.includes('_(no text)_'));
    assert.ok(body.includes('crash.txt'));
  });
});

describe('githubToDiscord', () => {
  test('converts alert callouts to bold', () => {
    assert.ok(githubToDiscord('> [!WARNING]\nbe careful').includes('**WARNING:**'));
  });

  test('collapses details blocks to their summary', () => {
    const out = githubToDiscord('<details><summary>Full log</summary>\n50kb of log\n</details>');
    assert.ok(out.includes('**Full log**'));
    assert.ok(!out.includes('50kb of log'));
  });

  test('converts task list checkboxes', () => {
    const out = githubToDiscord('- [ ] todo\n- [x] done');
    assert.ok(out.includes('☐'));
    assert.ok(out.includes('☑'));
  });
});

describe('truncateForDiscord', () => {
  test('leaves short messages untouched', () => {
    assert.equal(truncateForDiscord('short'), 'short');
  });

  test('never exceeds the 2000-character hard limit', () => {
    // Discord rejects the whole message over the limit, so this is a correctness
    // bound, not a cosmetic one.
    const out = truncateForDiscord('x'.repeat(5000), 'https://github.com/a/b/issues/1');
    assert.ok(out.length <= 2000, `length was ${out.length}`);
  });

  test('links back to the source when truncating', () => {
    const url = 'https://github.com/a/b/issues/1';
    assert.ok(truncateForDiscord('x'.repeat(5000), url).includes(url));
  });

  test('prefers to break on a paragraph boundary', () => {
    const body = 'a'.repeat(1500) + '\n\n' + 'b'.repeat(1500);
    const out = truncateForDiscord(body, 'https://example.com');
    // Compare only the relayed body: the appended suffix mentions "GitHub", which
    // itself contains a 'b' and would otherwise match.
    const relayed = out.split('\n\n…')[0];
    assert.equal(relayed, 'a'.repeat(1500));
  });
});

describe('parseBugReport', () => {
  test('splits priority from description', () => {
    assert.deepEqual(parseBugReport('#medium: redstone accumulator ponder not working'), {
      priority: 'medium',
      description: 'redstone accumulator ponder not working',
    });
  });

  test('is case-insensitive on the priority word', () => {
    assert.equal(parseBugReport('#HIGH: server crashes on join')?.priority, 'high');
  });

  test('tolerates missing space after the colon', () => {
    assert.equal(parseBugReport('#low:no recipe for seatwood planks')?.description, 'no recipe for seatwood planks');
  });

  test('an ordinary post title is not a bug report', () => {
    assert.equal(parseBugReport('rains way too much'), null);
  });

  test('rejects a priority word that is not one of the four', () => {
    assert.equal(parseBugReport('#critical: server on fire'), null);
  });
});

describe('bugReportToGithub', () => {
  test('matches the header already used on hand-triaged issues', () => {
    const body = bugReportToGithub({ priority: 'medium', reportedBy: 'llewellyns', description: 'rains way too much' });
    assert.equal(body, '**Priority:** medium\n**Reported by:** llewellyns (Discord)\n\nrains way too much');
  });

  test('appends attachments when present', () => {
    const body = bugReportToGithub({
      priority: 'high',
      reportedBy: 'ManaJar',
      description: 'crash on hit',
      attachments: [{ name: 'crash.txt', url: 'https://cdn.discord/crash.txt' }],
    });
    assert.ok(body.includes('crash.txt'));
  });
});

describe('threadName', () => {
  test('stays within the 100-character Discord limit', () => {
    assert.ok(threadName(42, 'y'.repeat(300)).length <= 100);
  });

  test('keeps the issue number visible', () => {
    assert.ok(threadName(42, 'y'.repeat(300)).startsWith('#42 '));
  });

  test('leaves a short title intact', () => {
    assert.equal(threadName(7, 'Server crash on join'), '#7 Server crash on join');
  });
});
