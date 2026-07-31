/**
 * GitHub polling.
 *
 * Webhooks need a public hostname to deliver to. With no domain there isn't one, so
 * the bridge asks GitHub for changes on an interval instead.
 *
 * Polling and webhooks can both be on at once — `message_links` already dedups by
 * comment ID, so whichever path sees an event first wins and the other is dropped.
 *
 * Cost: two API calls per tick. At the default 60s that's 120 calls/hour against an
 * authenticated limit of 5000, so roughly 2%.
 */

import type { BridgeDb } from './db.ts';
import type { GitHubSide } from './github.ts';
import type { Relay } from './relay.ts';
import { config } from './config.ts';

const CURSOR_KEY = 'github_last_polled_at';

/** Re-ask for a short window before the cursor, so nothing is lost to clock skew. */
const OVERLAP_MS = 60_000;

export class Poller {
  private db: BridgeDb;
  private github: GitHubSide;
  private relay: Relay;
  private intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(db: BridgeDb, github: GitHubSide, relay: Relay, intervalMs: number) {
    this.db = db;
    this.github = github;
    this.relay = relay;
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.timer) return;

    // Start from now on a first run rather than replaying the repo's whole history
    // into Discord.
    if (!this.db.getPollState(CURSOR_KEY)) {
      this.db.setPollState(CURSOR_KEY, new Date().toISOString());
      console.log('[poll] first run — starting from now');
    }

    console.log(`[poll] polling GitHub every ${this.intervalMs / 1000}s`);
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    // A slow tick must not overlap the next one, or the same events get processed
    // twice concurrently and both can pass the dedup check before either records.
    if (this.running) return;
    this.running = true;

    try {
      const cursor = this.db.getPollState(CURSOR_KEY) ?? new Date().toISOString();
      const since = new Date(Date.parse(cursor) - OVERLAP_MS).toISOString();

      // Advance the cursor to the start of this tick, not the end: anything created
      // while we were working is then picked up next time rather than skipped.
      const tickStartedAt = new Date().toISOString();

      const issues = await this.github.listIssuesSince(since);
      for (const issue of issues) {
        const existing = this.db.getThreadByIssue(config.github.repo, issue.number);

        if (!existing) {
          await this.relay.onIssueOpened({
            issue,
            repository: { full_name: config.github.repo },
          });
          continue;
        }

        // Reflect a state change we haven't recorded yet.
        const wanted = issue.state === 'closed' ? 'closed' : 'open';
        if (existing.state !== wanted) {
          await this.relay.onIssueStateChange(
            {
              issue,
              repository: { full_name: config.github.repo },
              sender: { login: issue.user?.login ?? 'someone' },
            },
            wanted === 'closed' ? 'closed' : 'reopened',
          );
        }
      }

      const comments = await this.github.listCommentsSince(since);
      for (const comment of comments) {
        // The comments endpoint doesn't include the issue body, so reconstruct the
        // shape onIssueComment expects from the comment's issue_url.
        const issueNumber = Number(comment.issue_url.split('/').pop());
        if (!Number.isFinite(issueNumber)) continue;

        // Cheap pre-check: skip the issue fetch entirely for comments we've seen.
        if (this.db.isAlreadyLinked({ githubCommentId: String(comment.id) })) continue;

        const issue = await this.github.getIssue(issueNumber);
        await this.relay.onIssueComment({
          issue,
          comment,
          repository: { full_name: config.github.repo },
        });
      }

      this.db.setPollState(CURSOR_KEY, tickStartedAt);
    } catch (err) {
      // Leave the cursor untouched on failure so the next tick retries the window.
      console.error('[poll] tick failed:', (err as Error).message);
      this.db.logEvent({
        source: 'github',
        eventType: 'poll',
        outcome: 'error',
        detail: String(err),
      });
    } finally {
      this.running = false;
    }
  }
}
