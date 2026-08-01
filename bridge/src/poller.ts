/**
 * GitHub polling.
 *
 * Webhooks need a public hostname to deliver to. With no domain there isn't one, so
 * the bridge asks GitHub for changes on an interval instead.
 *
 * Polling and webhooks can both be on at once — `message_links` already dedups by
 * comment ID, so whichever path sees an event first wins and the other is dropped.
 *
 * Cost: five API calls per tick — two for issues and comments, three for pull
 * requests, releases and failed workflow runs. At the default 60s that's 300
 * calls/hour against an authenticated limit of 5000, so roughly 6%.
 */

import type { BridgeDb } from './db.ts';
import type { GitHubSide } from './github.ts';
import type { Relay } from './relay.ts';
import { config } from './config.ts';

const CURSOR_KEY = 'github_last_polled_at';

/** Re-ask for a short window before the cursor, so nothing is lost to clock skew. */
const OVERLAP_MS = 60_000;

// CI notification cursors. Separate keys rather than one shared timestamp because
// the three streams need different dedup strategies — see pollCiEvents.
const PR_CURSOR_KEY = 'ci_last_pr_number';
const RELEASE_CURSOR_KEY = 'ci_last_release_id';
const RUN_SEEN_KEY = 'ci_seen_failed_run_ids';

/**
 * How many failed run ids to remember. Only needs to outlast the window in which a
 * run can still be re-returned by the API, so this is generous rather than tuned.
 */
const RUN_SEEN_LIMIT = 200;

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

      // Its own try/catch: a GitHub Actions hiccup should not stall issue relaying,
      // which is the bridge's actual job.
      try {
        await this.pollCiEvents();
      } catch (err) {
        console.error('[poll] ci events failed:', (err as Error).message);
      }
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

  // =========================================================================
  // CI notifications
  // =========================================================================

  /**
   * Announce pull requests, releases, and failed builds.
   *
   * These used to be pushed from GitHub Actions via notify-bridge.sh, which required
   * a publicly reachable BRIDGE_URL. There is no domain and no tunnel here, so those
   * jobs silently skipped on every run for the life of the repo — including release
   * v0.2.0. Pulling is the same trade already made for issues: no inbound
   * connectivity, no secrets to keep in sync, at the cost of up to one interval of
   * latency.
   *
   * **Only failures are reported for builds.** Under an enforced PR flow every
   * change produces a run, and a green tick is already visible on the PR that caused
   * it. Announcing successes would fill the channel with messages nobody reads,
   * which is the same way a shared alert channel fails.
   */
  private async pollCiEvents(): Promise<void> {
    await this.pollPullRequests();
    await this.pollReleases();
    await this.pollFailedRuns();
  }

  /**
   * Seed a cursor on first run instead of replaying the repo's history into Discord.
   * Returns null when seeding, so callers know to skip this pass.
   */
  private seedOrRead(key: string, current: number): number | null {
    const stored = this.db.getPollState(key);
    const parsed = stored === undefined ? NaN : Number(stored);

    // Re-seed on a missing *or* unparseable cursor. Without the NaN check a corrupt
    // value would leave every comparison against it false, so the stream would go
    // quiet permanently with nothing in the log to say why.
    if (!Number.isFinite(parsed)) {
      this.db.setPollState(key, String(current));
      console.log(`[poll] ci: seeding ${key} at ${current}${stored === undefined ? '' : ` (was unparseable: ${stored})`}`);
      return null;
    }
    return parsed;
  }

  private async pollPullRequests(): Promise<void> {
    const prs = await this.github.listRecentPullRequests();
    if (!prs.length) return;

    // PR numbers only ever increase and a PR is opened exactly once, so the highest
    // number seen is a complete cursor — no set needed.
    const highest = Math.max(...prs.map((p) => p.number));
    const lastSeen = this.seedOrRead(PR_CURSOR_KEY, highest);
    if (lastSeen === null) return;

    // Oldest first, so a burst arrives in the order it happened.
    const fresh = prs.filter((p) => p.number > lastSeen).sort((a, b) => a.number - b.number);

    for (const pr of fresh) {
      await this.relay.onCiEvent({
        kind: 'pr',
        name: `PR #${pr.number}: ${pr.title}`,
        detail: `\`${pr.head?.ref}\` → \`${pr.base?.ref}\` by ${pr.user?.login ?? 'someone'}`,
        url: pr.html_url,
      });
    }

    if (fresh.length) this.db.setPollState(PR_CURSOR_KEY, String(highest));
  }

  private async pollReleases(): Promise<void> {
    const releases = await this.github.listRecentReleases();
    if (!releases.length) return;

    const highest = Math.max(...releases.map((r) => r.id));
    const lastSeen = this.seedOrRead(RELEASE_CURSOR_KEY, highest);
    if (lastSeen === null) return;

    const fresh = releases.filter((r) => r.id > lastSeen).sort((a, b) => a.id - b.id);

    for (const release of fresh) {
      await this.relay.onCiEvent({
        kind: 'release',
        status: 'success',
        name: `Release ${release.tag_name}`,
        version: release.tag_name.replace(/^v/, ''),
        url: release.html_url,
      });
    }

    if (fresh.length) this.db.setPollState(RELEASE_CURSOR_KEY, String(highest));
  }

  private async pollFailedRuns(): Promise<void> {
    const runs = await this.github.listFailedWorkflowRuns();
    if (!runs.length) return;

    // A set rather than a high-water mark, unlike the two above. Run ids increase
    // with *creation*, but runs finish out of order — a slow run can fail after a
    // newer one already has. A max-id cursor would silently skip it, and the one it
    // skips is a failure, which is exactly what must not be dropped.
    const stored = this.db.getPollState(RUN_SEEN_KEY);
    if (stored === undefined) {
      this.db.setPollState(RUN_SEEN_KEY, JSON.stringify(runs.map((r) => r.id)));
      console.log(`[poll] ci: seeding ${RUN_SEEN_KEY} with ${runs.length} run(s)`);
      return;
    }

    const seen = new Set<number>(JSON.parse(stored) as number[]);
    const fresh = runs.filter((r) => !seen.has(r.id)).reverse();

    for (const run of fresh) {
      await this.relay.onCiEvent({
        kind: 'ci',
        status: 'failure',
        name: run.name ?? 'Workflow',
        detail: `branch \`${run.head_branch}\``,
        branch: run.head_branch ?? undefined,
        url: run.html_url,
      });
    }

    if (fresh.length) {
      for (const run of fresh) seen.add(run.id);
      // Newest first, then truncate — the oldest ids are the ones the API will stop
      // returning, so they are the safe ones to forget.
      const kept = [...seen].sort((a, b) => b - a).slice(0, RUN_SEEN_LIMIT);
      this.db.setPollState(RUN_SEEN_KEY, JSON.stringify(kept));
    }
  }
}
