/** GitHub side of the bridge. */

import { Octokit } from '@octokit/rest';
import { config, repoParts } from './config.ts';

export class GitHubSide {
  private octokit: Octokit;

  constructor() {
    this.octokit = new Octokit({ auth: config.github.token });
  }

  /** Post a comment on an issue. Returns the new comment's id. */
  async createComment(issueNumber: number, body: string): Promise<string> {
    const { owner, repo } = repoParts();
    const res = await this.octokit.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
    return String(res.data.id);
  }

  async getIssue(issueNumber: number) {
    const { owner, repo } = repoParts();
    const res = await this.octokit.issues.get({ owner, repo, issue_number: issueNumber });
    return res.data;
  }

  /**
   * Identify the authenticated account, so the relay can recognise and skip
   * comments it authored itself.
   */
  async whoami(): Promise<string> {
    const res = await this.octokit.users.getAuthenticated();
    return res.data.login;
  }

  /**
   * Issues created or updated since a timestamp, newest activity last.
   *
   * `since` filters on *updated* time, so this also returns older issues that just
   * received activity — the caller decides what to do with each.
   */
  async listIssuesSince(since: string) {
    const { owner, repo } = repoParts();
    const res = await this.octokit.issues.listForRepo({
      owner,
      repo,
      state: 'all',
      since,
      sort: 'updated',
      direction: 'asc',
      per_page: 100,
    });
    return res.data.filter((i) => !i.pull_request);
  }

  /**
   * Every issue comment across the repo since a timestamp.
   *
   * One call covers all issues, which is what makes polling cheap enough to run on a
   * short interval without burning the rate limit.
   */
  async listCommentsSince(since: string) {
    const { owner, repo } = repoParts();
    const res = await this.octokit.issues.listCommentsForRepo({
      owner,
      repo,
      since,
      sort: 'created',
      direction: 'asc',
      per_page: 100,
    });
    return res.data;
  }

  /**
   * Pull requests, newest first.
   *
   * `state: 'all'` rather than `'open'` on purpose: a PR opened and merged between
   * two ticks is still worth announcing, and filtering to open would drop it.
   */
  async listRecentPullRequests(limit = 20) {
    const { owner, repo } = repoParts();
    const res = await this.octokit.pulls.list({
      owner,
      repo,
      state: 'all',
      sort: 'created',
      direction: 'desc',
      per_page: limit,
    });
    return res.data;
  }

  /**
   * Workflow runs that finished in failure, newest first.
   *
   * GitHub accepts conclusion values in the `status` filter, so this asks the API
   * for failures rather than pulling every run and discarding the green ones.
   */
  async listFailedWorkflowRuns(limit = 30) {
    const { owner, repo } = repoParts();
    const res = await this.octokit.actions.listWorkflowRunsForRepo({
      owner,
      repo,
      status: 'failure',
      per_page: limit,
    });
    return res.data.workflow_runs;
  }

  /** Published releases, newest first. */
  async listRecentReleases(limit = 10) {
    const { owner, repo } = repoParts();
    const res = await this.octokit.repos.listReleases({ owner, repo, per_page: limit });
    return res.data.filter((r) => !r.draft);
  }

  /** Remaining core API quota, for logging when polling. */
  async rateLimitRemaining(): Promise<number> {
    const res = await this.octokit.rateLimit.get();
    return res.data.resources.core.remaining;
  }

  /** Open issues, used to backfill threads for issues that predate the bridge. */
  async listOpenIssues(): Promise<{ number: number; title: string; body: string; user: string; url: string }[]> {
    const { owner, repo } = repoParts();
    const res = await this.octokit.issues.listForRepo({
      owner,
      repo,
      state: 'open',
      per_page: 100,
    });
    return res.data
      // The Issues API returns PRs too; they are not issues for our purposes.
      .filter((i) => !i.pull_request)
      .map((i) => ({
        number: i.number,
        title: i.title,
        body: i.body ?? '',
        user: i.user?.login ?? 'unknown',
        url: i.html_url,
      }));
  }
}
