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

import type { Message, ThreadChannel } from 'discord.js';
import type { BridgeDb } from './db.ts';
import type { DiscordSide } from './discord.ts';
import type { GitHubSide } from './github.ts';
import { config } from './config.ts';
import { bugReportToGithub, discordToGithub, githubToDiscord, isRelayedComment, parseBugReport, threadName } from './format.ts';
import { isUrgentCiEvent, type CiEvent } from './routing.ts';

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

    // Defence: an issue the bridge itself created — via /file, or a report filed
    // straight from Discord — is authored as the bridge's own GitHub account and is
    // already linked to a thread by the code that created it, synchronously, before
    // this can ever see it. Skip on identity rather than trusting that timing: the
    // window between that issue existing on GitHub and the link being written is the
    // only thing `getThreadByIssue` below has to catch a race in, and losing that
    // race duplicates the thread — `createThread`'s ON CONFLICT UPDATE then makes the
    // duplicate win, orphaning the original.
    if (issue.user?.login === this.selfLogin) {
      this.db.logEvent({ source: 'github', eventType: 'issues.opened', outcome: 'ignored', detail: 'self-authored' });
      return;
    }

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

    if (!msg.channel.isThread()) {
      if (msg.channelId === config.discord.issueChannelId) await this.onDiscordChannelMessage(msg);
      return;
    }

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

    this.db.logEvent({
      source: 'discord',
      eventType: 'messageCreate',
      outcome: 'relayed',
      detail: `thread ${msg.channel.id} -> #${thread.issue_number} comment ${commentId}`,
    });
  }

  /**
   * Build the title/body/labels for a bug report, shared by both ways a report can
   * arrive: a new forum post (`onDiscordThreadCreated`) or a message typed directly
   * into a plain-text issue channel (`onDiscordChannelMessage`).
   *
   * Players report bugs as "#low|medium|high|urgent: description", either as a
   * forum post's title or as the message text itself — matching the existing
   * hand-triaged issues gets this straight onto the same priority labels instead of
   * waiting on a human to relabel it later.
   */
  private buildIssueContent(opts: {
    titleSource: string;
    content: string;
    displayName: string;
    githubLogin?: string | null;
    attachments: { name: string; url: string }[];
    jumpUrl?: string;
  }): { title: string; body: string; labels?: string[] } {
    const parsed = parseBugReport(opts.titleSource) ?? parseBugReport(opts.content);
    const title = parsed?.description || opts.titleSource || opts.content.slice(0, 80) || 'Bug report';

    const body = parsed
      ? bugReportToGithub({
          priority: parsed.priority,
          reportedBy: opts.displayName,
          description: parsed.description,
          attachments: opts.attachments,
        })
      : discordToGithub({
          displayName: opts.displayName,
          githubLogin: opts.githubLogin,
          content: opts.content,
          attachments: opts.attachments,
          jumpUrl: opts.jumpUrl,
        });

    return { title, body, labels: parsed ? ['bug', `priority-${parsed.priority}`] : undefined };
  }

  /**
   * A new post in the issue forum — files it as a GitHub issue.
   *
   * Guarded against the loop this would otherwise create: `onIssueOpened` makes a
   * thread for every new issue, and that thread's own creation event would arrive
   * here right back. `thread.ownerId` is the Discord user who started the post, so a
   * thread the bridge itself created is owned by the bot and skipped — the same role
   * the author check plays for comments. The same guard also covers the thread
   * `onDiscordChannelMessage` spins up below: it starts that thread through the bot,
   * so it too arrives here bot-owned and is skipped rather than filed twice.
   */
  async onDiscordThreadCreated(thread: ThreadChannel): Promise<void> {
    if (thread.ownerId === this.discord.botUserId) return;
    if (this.db.getThreadByDiscordThread(thread.id)) return;

    // Not `thread.fetchStarterMessage()`: for a thread started from an already-
    // existing message (as opposed to a fresh forum post), that returns nothing —
    // the real message lives in the parent channel and only a stub sits in the
    // thread itself. `fetchAllMessages` already resolves that stub to the real
    // message, so the oldest entry it returns is right either way.
    const [starter] = await this.discord.fetchAllMessages(thread);
    if (!starter || starter.author.bot) return;

    const actor = this.db.getActorByDiscord(starter.author.id);
    const displayName = starter.member?.displayName ?? starter.author.username;
    const attachments = [...starter.attachments.values()].map((a) => ({ name: a.name, url: a.url }));

    const { title, body, labels } = this.buildIssueContent({
      titleSource: thread.name,
      content: starter.content,
      displayName,
      githubLogin: actor?.github_login,
      attachments,
      jumpUrl: starter.url,
    });

    const issue = await this.github.createIssue({ title, body, labels });

    const created = this.db.createThread({
      repo: config.github.repo,
      issueNumber: issue.number,
      channelId: thread.parentId ?? config.discord.issueChannelId,
      threadId: thread.id,
      title,
    });

    this.db.recordLink({
      threadId: created.id,
      discordMessageId: starter.id,
      direction: 'dc->gh',
      authorKind: (actor?.kind as any) ?? 'human',
    });

    await this.discord.postSystemMessage(thread.id, `📮 Filed as [#${issue.number}](${issue.url})`);

    this.db.logEvent({
      source: 'discord',
      eventType: 'threadCreate',
      outcome: 'relayed',
      detail: `thread ${thread.id} -> #${issue.number}`,
    });
  }

  /**
   * A message posted directly into the issue channel, rather than inside a thread —
   * what actually happens when that channel is plain text rather than a forum, which
   * has no "new post" action to hang `onDiscordThreadCreated` off of. Files it as a
   * GitHub issue exactly like a forum post, then starts a thread from the message so
   * the two directions still meet in one place afterwards.
   */
  async onDiscordChannelMessage(msg: Message): Promise<void> {
    if (msg.content.startsWith('//')) return;

    const actor = this.db.getActorByDiscord(msg.author.id);
    const displayName = msg.member?.displayName ?? msg.author.username;
    const attachments = [...msg.attachments.values()].map((a) => ({ name: a.name, url: a.url }));

    const { title, body, labels } = this.buildIssueContent({
      titleSource: '',
      content: msg.content,
      displayName,
      githubLogin: actor?.github_login,
      attachments,
      jumpUrl: msg.url,
    });

    const issue = await this.github.createIssue({ title, body, labels });
    const { threadId, channelId } = await this.discord.startThreadFromMessage(msg, threadName(issue.number, title));

    const created = this.db.createThread({
      repo: config.github.repo,
      issueNumber: issue.number,
      channelId,
      threadId,
      title,
    });

    this.db.recordLink({
      threadId: created.id,
      discordMessageId: msg.id,
      direction: 'dc->gh',
      authorKind: (actor?.kind as any) ?? 'human',
    });

    await this.discord.postSystemMessage(threadId, `📮 Filed as [#${issue.number}](${issue.url})`);

    this.db.logEvent({
      source: 'discord',
      eventType: 'messageCreate',
      outcome: 'relayed',
      detail: `channel message ${msg.id} -> #${issue.number}, thread ${threadId}`,
    });
  }

  /**
   * Close or reopen the issue behind a thread, from a `/close` or `/reopen` command
   * run inside it.
   *
   * Updates `issue_threads.state` itself rather than waiting on the poller to notice.
   * `poller.tick()` only calls `onIssueStateChange` when `existing.state !== wanted`,
   * so once this has already recorded the new state, the poll tick that later sees
   * the same change on GitHub finds nothing to do — the same compare-and-skip that
   * already keeps a webhook and a poll tick from double-reporting one transition.
   * Archiving is left to the caller: it happens after the command's own reply is
   * sent, so replying doesn't race a bot un-archiving the thread it just closed.
   */
  async setIssueStateFromDiscord(
    threadId: string,
    action: 'closed' | 'reopened',
    actorDisplayName: string,
  ): Promise<{ ok: true; issueNumber: number; url: string } | { ok: false; reason: 'not-linked' | 'already' }> {
    const thread = this.db.getThreadByDiscordThread(threadId);
    if (!thread) return { ok: false, reason: 'not-linked' };

    const wanted = action === 'closed' ? 'closed' : 'open';
    if (thread.state === wanted) return { ok: false, reason: 'already' };

    const { url } = await this.github.setIssueState(thread.issue_number, wanted);
    this.db.setThreadState(thread.repo, thread.issue_number, wanted);

    this.db.logEvent({
      source: 'discord',
      eventType: `issues.${action}`,
      outcome: 'relayed',
      detail: `#${thread.issue_number} ${action} by ${actorDisplayName} via /${action === 'closed' ? 'close' : 'reopen'}`,
    });

    return { ok: true, issueNumber: thread.issue_number, url };
  }

  /**
   * File an existing thread as a GitHub issue, from a `/file` command run inside it.
   *
   * Unlike `onDiscordThreadCreated` / `onDiscordChannelMessage`, this thread may
   * already have a real conversation in it — it might not even be in the configured
   * issue channel, since the point of a manual command is covering threads the
   * automatic paths never saw. The oldest message becomes the issue itself (same
   * parsing and formatting as those two); everything after it is created as a
   * comment, oldest first, and recorded in `message_links` exactly like a live
   * relay so none of it is ever re-sent if the thread stays active afterwards.
   */
  async fileThreadAsIssue(threadId: string): Promise<
    | { ok: true; issueNumber: number; url: string; backfilled: number }
    | { ok: false; reason: 'not-a-thread' | 'empty' }
    | { ok: false; reason: 'already-linked'; issueNumber: number; url: string }
  > {
    const existing = this.db.getThreadByDiscordThread(threadId);
    if (existing) {
      return {
        ok: false,
        reason: 'already-linked',
        issueNumber: existing.issue_number,
        url: `https://github.com/${existing.repo}/issues/${existing.issue_number}`,
      };
    }

    const thread = await this.discord.fetchThread(threadId);
    if (!thread) return { ok: false, reason: 'not-a-thread' };

    const messages = await this.discord.fetchAllMessages(thread);
    const human = messages.filter((m) => !m.author.bot && !m.webhookId);
    const [starter, ...rest] = human;
    if (!starter) return { ok: false, reason: 'empty' };

    const actor = this.db.getActorByDiscord(starter.author.id);
    const { title, body, labels } = this.buildIssueContent({
      titleSource: thread.name,
      content: starter.content,
      displayName: starter.member?.displayName ?? starter.author.username,
      githubLogin: actor?.github_login,
      attachments: [...starter.attachments.values()].map((a) => ({ name: a.name, url: a.url })),
      jumpUrl: starter.url,
    });

    const issue = await this.github.createIssue({ title, body, labels });

    const created = this.db.createThread({
      repo: config.github.repo,
      issueNumber: issue.number,
      channelId: thread.parentId ?? config.discord.issueChannelId,
      threadId: thread.id,
      title,
    });

    this.db.recordLink({
      threadId: created.id,
      discordMessageId: starter.id,
      direction: 'dc->gh',
      authorKind: (actor?.kind as any) ?? 'human',
    });

    let backfilled = 0;
    for (const msg of rest) {
      if (msg.content.startsWith('//')) continue;

      const msgActor = this.db.getActorByDiscord(msg.author.id);
      const commentBody = discordToGithub({
        displayName: msg.member?.displayName ?? msg.author.username,
        githubLogin: msgActor?.github_login,
        content: msg.content,
        attachments: [...msg.attachments.values()].map((a) => ({ name: a.name, url: a.url })),
        jumpUrl: msg.url,
      });

      const commentId = await this.github.createComment(issue.number, commentBody);
      this.db.recordLink({
        threadId: created.id,
        githubCommentId: commentId,
        discordMessageId: msg.id,
        direction: 'dc->gh',
        authorKind: (msgActor?.kind as any) ?? 'human',
      });
      backfilled++;
    }

    this.db.logEvent({
      source: 'discord',
      eventType: 'file',
      outcome: 'relayed',
      detail: `thread ${thread.id} -> #${issue.number}, backfilled ${backfilled} comment(s)`,
    });

    return { ok: true, issueNumber: issue.number, url: issue.url, backfilled };
  }

  // =========================================================================
  // CI events
  // =========================================================================

  async onCiEvent(event: CiEvent): Promise<void> {
    // A pull request has no pass/fail outcome to report, so it gets its own icon
    // rather than the generic notice one — it reads as an event, not a result.
    const icon =
      event.status === 'success' ? '✅' :
      event.status === 'failure' ? '❌' :
      event.status === 'cancelled' ? '⚪' :
      event.kind === 'pr' ? '🔀' : 'ℹ️';

    const lines = [`${icon} **${event.name ?? event.kind}**`];
    if (event.version) lines.push(`Version: \`${event.version}\``);
    if (event.detail) lines.push(event.detail);
    if (event.url) lines.push(`<${event.url}>`);

    // Routed on an explicit `branch` field rather than by parsing `detail`, which
    // exists only to be rendered and is free to change wording. See routing.ts for
    // why a broken main counts as an outage.
    const isDefaultBranchFailure = isUrgentCiEvent(event);

    if (isDefaultBranchFailure) {
      await this.discord.postToAlertChannel(lines.join('\n'));
    } else {
      await this.discord.postToCiChannel(lines.join('\n'));
    }

    this.db.logEvent({
      source: 'ci',
      eventType: event.kind,
      outcome: 'relayed',
      payload: { ...event, routedTo: isDefaultBranchFailure ? 'alert' : 'ci' },
    });
  }

  /**
   * A problem with the bridge itself, rather than something it observed.
   *
   * Goes to the alert channel: a stream that has stopped working means GitHub
   * activity is silently not reaching Discord, and the symptom of that is an empty
   * channel — indistinguishable from a quiet day.
   */
  async onBridgeAlert(opts: { title: string; detail?: string; recovered?: boolean }): Promise<void> {
    const icon = opts.recovered ? '🟢' : '🔴';
    const lines = [`${icon} **${opts.title}**`];
    if (opts.detail) lines.push(opts.detail);

    await this.discord.postToAlertChannel(lines.join('\n'));
    this.db.logEvent({
      source: 'ci',
      eventType: opts.recovered ? 'bridge.recovered' : 'bridge.degraded',
      outcome: 'relayed',
      payload: opts,
    });
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

    await this.discord.postToAlertChannel(lines.join('\n'));
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
