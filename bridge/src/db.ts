/**
 * SQLite access layer.
 *
 * Everything the relay needs to decide "have I already seen this?" lives here.
 * That question is the whole ballgame: get it wrong and the bridge echoes messages
 * back and forth forever.
 */

import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export type Direction = 'gh->dc' | 'dc->gh';
export type AuthorKind = 'human' | 'bot' | 'agent' | 'system';

export interface IssueThread {
  id: number;
  repo: string;
  issue_number: number;
  discord_channel_id: string;
  discord_thread_id: string;
  issue_title: string | null;
  state: string;
}

export class BridgeDb {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  /** Apply every .sql file in migrations/ once, in filename order. */
  private migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

    const dir = join(__dirname, '..', 'migrations');
    const applied = new Set(
      this.db.prepare('SELECT name FROM _migrations').all().map((r: any) => r.name),
    );

    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(dir, file), 'utf8');
      this.db.exec(sql);
      this.db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
      console.log(`[db] applied migration ${file}`);
    }
  }

  // -------------------------------------------------------------------------
  // issue threads
  // -------------------------------------------------------------------------

  getThreadByIssue(repo: string, issueNumber: number): IssueThread | undefined {
    return this.db
      .prepare('SELECT * FROM issue_threads WHERE repo = ? AND issue_number = ?')
      .get(repo, issueNumber) as IssueThread | undefined;
  }

  getThreadByDiscordThread(threadId: string): IssueThread | undefined {
    return this.db
      .prepare('SELECT * FROM issue_threads WHERE discord_thread_id = ?')
      .get(threadId) as IssueThread | undefined;
  }

  createThread(t: {
    repo: string;
    issueNumber: number;
    channelId: string;
    threadId: string;
    title: string;
  }): IssueThread {
    this.db
      .prepare(
        `INSERT INTO issue_threads
           (repo, issue_number, discord_channel_id, discord_thread_id, issue_title)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (repo, issue_number) DO UPDATE SET
           discord_thread_id = excluded.discord_thread_id,
           updated_at = datetime('now')`,
      )
      .run(t.repo, t.issueNumber, t.channelId, t.threadId, t.title);
    return this.getThreadByIssue(t.repo, t.issueNumber)!;
  }

  setThreadState(repo: string, issueNumber: number, state: string): void {
    this.db
      .prepare(
        `UPDATE issue_threads SET state = ?, updated_at = datetime('now')
         WHERE repo = ? AND issue_number = ?`,
      )
      .run(state, repo, issueNumber);
  }

  // -------------------------------------------------------------------------
  // loop prevention
  // -------------------------------------------------------------------------

  /**
   * True if this ID was produced by, or already handled by, the bridge.
   *
   * Called before relaying in either direction. A GitHub comment the bridge itself
   * posted (because it came from Discord) is already recorded here, so the inbound
   * webhook for that comment is dropped rather than sent back to Discord.
   */
  isAlreadyLinked(ids: { githubCommentId?: string; discordMessageId?: string }): boolean {
    if (ids.githubCommentId) {
      const hit = this.db
        .prepare('SELECT 1 FROM message_links WHERE github_comment_id = ?')
        .get(ids.githubCommentId);
      if (hit) return true;
    }
    if (ids.discordMessageId) {
      const hit = this.db
        .prepare('SELECT 1 FROM message_links WHERE discord_message_id = ?')
        .get(ids.discordMessageId);
      if (hit) return true;
    }
    return false;
  }

  recordLink(link: {
    threadId: number | null;
    githubCommentId?: string;
    discordMessageId?: string;
    direction: Direction;
    authorKind?: AuthorKind;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO message_links
           (thread_id, github_comment_id, discord_message_id, direction, author_kind)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        link.threadId,
        link.githubCommentId ?? null,
        link.discordMessageId ?? null,
        link.direction,
        link.authorKind ?? 'human',
      );
  }

  // -------------------------------------------------------------------------
  // actors
  // -------------------------------------------------------------------------

  getActorByDiscord(discordUserId: string): { github_login: string | null; kind: string } | undefined {
    return this.db
      .prepare('SELECT github_login, kind FROM actors WHERE discord_user_id = ?')
      .get(discordUserId) as any;
  }

  linkActor(discordUserId: string, githubLogin: string, displayName: string): void {
    this.db
      .prepare(
        `INSERT INTO actors (discord_user_id, github_login, display_name)
         VALUES (?, ?, ?)
         ON CONFLICT (discord_user_id) DO UPDATE SET
           github_login = excluded.github_login,
           display_name = excluded.display_name`,
      )
      .run(discordUserId, githubLogin, displayName);
  }

  // -------------------------------------------------------------------------
  // poll cursor
  // -------------------------------------------------------------------------

  getPollState(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM poll_state WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setPollState(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO poll_state (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      )
      .run(key, value);
  }

  // -------------------------------------------------------------------------
  // audit
  // -------------------------------------------------------------------------

  logEvent(e: {
    source: string;
    eventType: string;
    payload?: unknown;
    outcome: string;
    detail?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO event_log (source, event_type, payload, outcome, detail)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        e.source,
        e.eventType,
        e.payload ? JSON.stringify(e.payload).slice(0, 20000) : null,
        e.outcome,
        e.detail ?? null,
      );
  }

  close(): void {
    this.db.close();
  }
}
