/**
 * The relay: the rules for moving a message from one surface to the other.
 *
 * ## Loop prevention
 *
 * Every relay creates a message on the far side, and that creation fires an event
 * that looks exactly like a user message. Without a guard the bridge amplifies a
 * single comment into an infinite loop across both platforms within seconds.
 *
 * Three independent defences, in order of cost:
 *
 *   1. Author check     — ignore anything authored by our own bot/token. Catches
 *                         the common case with no DB round-trip.
 *   2. Marker check     — relayed GitHub comments carry an HTML comment marker.
 *                         Survives the DB being lost or rebuilt.
 *   3. message_links    — the authoritative record. Every relayed message is
 *                         recorded under both IDs; a known ID is never relayed again.
 *
 * Any one of these would usually be enough. All three are here because the failure
 * mode is loud, public, and hits two platforms' rate limits at once.
 */

import type { Message } from 'discord.js';
import type { BridgeDb } from './db.ts';
import type { DiscordSide } from './discord.ts';
import type { GitHubSide } from './github.ts';
import { config } from './config.ts';
import { discordToGithub, githubToDiscord, isRelayedComment, threadName } from './format.ts';

export class Relay {
  /** Login of the GitHub account the bridge posts as. */
  private selfLogin = '';

  // Declared as fields rather than constructor parameter properties: Node runs these
  // files by stripping types, which only supports erasable syntax, and parameter
  // properties emit real code.
  private db: BridgeDb;
  private discord: DiscordSide;
  private github: GitHubSide;

  constructor(db: BridgeDb, discord: DiscordSide, github: GitHubSide) {
    this.db = db;
    this.discord = discord;
    this.github = github;
  }

  async init(): Promise<void> {
    this.selfLogin = await this.github.whoami();
    console.log(`[relay] github identity: ${this.selfLogin}`);
  }

  // =========================================================================
  // GitHub -> Discord
  // =========================================================================

  async onIssueOpened(payload: any): Promise<void> {
    const issue = payload.issue;
    const repo = payload.repository.full_name;

    if (this.db.getThreadByIssue(repo, issue.number)) {
      this.db.logEvent({ source: 'github', eventType: 'issues.opened', outcome: 'ignored', detail: 'thread exists' });
      return;
    }

    const { threadId, channelId } = await this.discord.createIssueThread({
      issueNumber: issue.number,
      title: issue.title,
      body: githubToDiscord(issue.body ?? ''),
      author: issue.user?.login ?? 'unknown',
      avatarUrl: issue.user?.avatar_url,
      url: issue.html_url,
    });

    this.db.createThread({
      repo,
      issueNumber: issue.number,
      channelId,
      threadId,
      title: issue.title,
    });

    this.db.logEvent({
      source: 'github',
      eventType: 'issues.opened',
      outcome: 'relayed',
      detail: `#${issue.number} -> thread ${threadId}`,
    });
  }

  async onIssueComment(payload: any): Promise<void> {
    const issue = payload.issue;
    const comment = payload.comment;
    const repo = payload.repository.full_name;
    const commentId = String(comment.id);

    // Defence 1: our own account.
    if (comment.user?.login === this.selfLogin) {
      this.db.logEvent({ source: 'github', eventType: 'issue_comment', outcome: 'ignored', detail: 'self-authored' });
      return;
    }

    // Defence 2: the relay marker.
    if (isRelayedComment(comment.body ?? '')) {
      this.db.logEvent({ source: 'github', eventType: 'issue_comment', outcome: 'ignored', detail: 'relay marker' });
      return;
    }

    // Defence 3: already recorded.
    if (this.db.isAlreadyLinked({ githubCommentId: commentId })) {
      this.db.logEvent({ source: 'github', eventType: 'issue_comment', outcome: 'ignored', detail: 'already linked' });
      return;
    }

    // A comment can arrive on an issue that predates the bridge; create the thread
    // on demand rather than dropping the message.
    let thread = this.db.getThreadByIssue(repo, issue.number);
    if (!thread) {
      const created = await this.discord.createIssueThread({
        issueNumber: issue.number,
        title: issue.title,
        body: githubToDiscord(issue.body ?? ''),
        author: issue.user?.login ?? 'unknown',
        avatarUrl: issue.user?.avatar_url,
        url: issue.html_url,
      });
      thread = this.db.createThread({
        repo,
        issueNumber: issue.number,
        channelId: created.channelId,
        threadId: created.threadId,
        title: issue.title,
      });
    }

    const discordMessageId = await this.discord.postRelayedComment({
      threadId: thread.discord_thread_id,
      channelId: thread.discord_channel_id,
      author: comment.user?.login ?? 'unknown',
      avatarUrl: comment.user?.avatar_url,
      body: githubToDiscord(comment.body ?? ''),
      sourceUrl: comment.html_url,
    });

    this.db.recordLink({
      threadId: thread.id,
      githubCommentId: commentId,
      discordMessageId,
      direction: 'gh->dc',
      authorKind: comment.user?.type === 'Bot' ? 'bot' : 'human',
    });

    this.db.logEvent({
      source: 'github',
      eventType: 'issue_comment',
      outcome: 'relayed',
      detail: `#${issue.number} comment ${commentId}`,
    });
  }

  async onIssueStateChange(payload: any, action: 'closed' | 'reopened'): Promise<void> {
    const repo = payload.repository.full_name;
    const issue = payload.issue;
    const thread = this.db.getThreadByIssue(repo, issue.number);
    if (!thread) return;

    const actor = payload.sender?.login ?? 'someone';
    const verb = action === 'closed' ? 'closed' : 'reopened';
    await this.discord.postSystemMessage(
      thread.discord_thread_id,
      `🔒 **${actor}** ${verb} [#${issue.number}](${issue.html_url})`,
    );

    this.db.setThreadState(repo, issue.number, action === 'closed' ? 'closed' : 'open');

    // Archiving a closed issue's thread keeps the forum tidy. Discord un-archives
    // automatically when someone posts, so this does not block further discussion.
    if (action === 'closed') await this.discord.setThreadArchived(thread.discord_thread_id, true);
    else await this.discord.setThreadArchived(thread.discord_thread_id, false);

    this.db.logEvent({ source: 'github', eventType: `issues.${action}`, outcome: 'relayed' });
  }

  // =========================================================================
  // Discord -> GitHub
  // =========================================================================

  async onDiscordMessage(msg: Message): Promise<void> {
    // Defence 1: our own bot, and any webhook — every relayed message we post is
    // sent through our webhook, so this single check covers all bridge output.
    if (msg.author.bot || msg.webhookId) return;
    if (msg.author.id === this.discord.botUserId) return;

    if (!msg.channel.isThread()) return;

    const thread = this.db.getThreadByDiscordThread(msg.channel.id);
    if (!thread) return;

    // Defence 3: already recorded.
    if (this.db.isAlreadyLinked({ discordMessageId: msg.id })) return;

    // Let people talk without relaying every word: a leading `//` marks a local aside.
    if (msg.content.startsWith('//')) {
      this.db.logEvent({ source: 'discord', eventType: 'messageCreate', outcome: 'ignored', detail: 'local aside' });
      return;
    }

    const actor = this.db.getActorByDiscord(msg.author.id);

    const body = discordToGithub({
      displayName: msg.member?.displayName ?? msg.author.username,
      githubLogin: actor?.github_login,
      content: msg.content,
      attachments: [...msg.attachments.values()].map((a) => ({ name: a.name, url: a.url })),
      jumpUrl: msg.url,
    });

    const commentId = await this.github.createComment(thread.issue_number, body);

    this.db.recordLink({
      threadId: thread.id,
      githubCommentId: commentId,
      discordMessageId: msg.id,
      direction: 'dc->gh',
      authorKind: (actor?.kind as any) ?? 'human',
    });

    // A subtle acknowledgement so people can see the message landed on GitHub.
    await msg.react('✅').catch(() => {});

    this.db.logEvent({
      source: 'discord',
      eventType: 'messageCreate',
      outcome: 'relayed',
      detail: `thread ${msg.channel.id} -> #${thread.issue_number} comment ${commentId}`,
    });
  }

  // =========================================================================
  // CI events
  // =========================================================================

  async onCiEvent(event: {
    kind: string;
    status?: string;
    name?: string;
    version?: string;
    url?: string;
    detail?: string;
  }): Promise<void> {
    const icon =
      event.status === 'success' ? '✅' :
      event.status === 'failure' ? '❌' :
      event.status === 'cancelled' ? '⚪' : 'ℹ️';

    const lines = [`${icon} **${event.name ?? event.kind}**`];
    if (event.version) lines.push(`Version: \`${event.version}\``);
    if (event.detail) lines.push(event.detail);
    if (event.url) lines.push(`<${event.url}>`);

    await this.discord.postToCiChannel(lines.join('\n'));
    this.db.logEvent({ source: 'ci', eventType: event.kind, outcome: 'relayed', payload: event });
  }

  // =========================================================================
  // Monitoring alerts
  // =========================================================================

  /**
   * Handle an inbound monitoring alert.
   *
   * Shaped around Uptime Kuma's webhook payload, which nests the interesting fields
   * under `heartbeat` and `monitor`, but falls back to top-level fields so other
   * tools (or a plain curl) work without a translation layer.
   */
  async onAlert(payload: any): Promise<void> {
    const monitorName = payload?.monitor?.name ?? payload?.name ?? 'monitor';
    const status = payload?.heartbeat?.status;

    // Uptime Kuma: 0 = down, 1 = up. Absent for other senders, so fall back to a
    // string status and treat anything unrecognised as a notice rather than an alarm.
    const isDown = status === 0 || payload?.status === 'down';
    const isUp = status === 1 || payload?.status === 'up';

    const icon = isDown ? '🔴' : isUp ? '🟢' : 'ℹ️';
    const state = isDown ? 'is DOWN' : isUp ? 'is back up' : 'reported';

    const lines = [`${icon} **${monitorName}** ${state}`];

    const msg = payload?.msg ?? payload?.heartbeat?.msg ?? payload?.detail;
    if (msg) lines.push(String(msg).slice(0, 500));

    const ping = payload?.heartbeat?.ping;
    if (isUp && typeof ping === 'number') lines.push(`Response time: ${ping}ms`);

    await this.discord.postToCiChannel(lines.join('\n'));
    this.db.logEvent({
      source: 'ci',
      eventType: `alert.${isDown ? 'down' : isUp ? 'up' : 'notice'}`,
      outcome: 'relayed',
      payload,
    });
  }

  // =========================================================================
  // Backfill
  // =========================================================================

  /** Create threads for open issues that predate the bridge. Safe to re-run. */
  async backfill(): Promise<number> {
    const issues = await this.github.listOpenIssues();
    let created = 0;

    for (const issue of issues) {
      if (this.db.getThreadByIssue(config.github.repo, issue.number)) continue;

      const t = await this.discord.createIssueThread({
        issueNumber: issue.number,
        title: issue.title,
        body: githubToDiscord(issue.body),
        author: issue.user,
        url: issue.url,
      });
      this.db.createThread({
        repo: config.github.repo,
        issueNumber: issue.number,
        channelId: t.channelId,
        threadId: t.threadId,
        title: issue.title,
      });
      created++;

      // Stay well clear of Discord's channel-creation rate limit.
      await new Promise((r) => setTimeout(r, 2000));
    }

    return created;
  }
}
