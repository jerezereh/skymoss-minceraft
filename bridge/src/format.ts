/**
 * Message formatting between the two surfaces.
 *
 * Discord and GitHub both speak Markdown, but not the same Markdown, and each has a
 * hard length limit that the other does not. These helpers keep relayed messages
 * readable and — more importantly — keep them from being rejected outright.
 */

/** Discord rejects any message body over 2000 characters. */
const DISCORD_MAX = 2000;

/** Marker appended to relayed GitHub comments so the bridge and humans can spot them. */
export const RELAY_MARKER = '<!-- skymoss-bridge:relayed -->';

export function isRelayedComment(body: string): boolean {
  return body.includes(RELAY_MARKER);
}

/**
 * Format a Discord message for posting as a GitHub issue comment.
 *
 * The marker is a defence-in-depth check behind message_links: if the DB were ever
 * lost or rebuilt, the marker still identifies bridge-authored comments and stops
 * the relay from re-ingesting its own output.
 */
export function discordToGithub(opts: {
  displayName: string;
  githubLogin?: string | null;
  content: string;
  attachments?: { name: string; url: string }[];
  jumpUrl?: string;
}): string {
  const who = opts.githubLogin
    ? `**@${opts.githubLogin}** (via Discord)`
    : `**${opts.displayName}** (via Discord)`;

  const parts = [RELAY_MARKER, `${who}:`, '', opts.content.trim() || '_(no text)_'];

  if (opts.attachments?.length) {
    parts.push('', '---', '**Attachments:**');
    for (const a of opts.attachments) parts.push(`- [${a.name}](${a.url})`);
  }

  return parts.join('\n');
}

/**
 * Convert GitHub comment markdown into something safe for Discord.
 *
 * GitHub-only syntax is downgraded rather than dropped, so meaning survives even
 * where rendering cannot.
 */
export function githubToDiscord(body: string): string {
  let out = body;

  // Strip our own marker so relayed text never shows it.
  out = out.replaceAll(RELAY_MARKER, '');

  // GitHub alert callouts (> [!NOTE]) render as raw text on Discord; make them bold.
  out = out.replace(/^>\s*\[!(\w+)\]/gm, (_m, kind) => `**${String(kind).toUpperCase()}:**`);

  // <details> blocks collapse to their summary; the body is usually logs.
  out = out.replace(
    /<details>\s*<summary>(.*?)<\/summary>([\s\S]*?)<\/details>/gi,
    (_m, summary) => `**${String(summary).trim()}** _(details omitted — see GitHub)_`,
  );

  // Task lists: Discord has no checkbox rendering.
  out = out.replace(/^(\s*)- \[ \]/gm, '$1- ☐').replace(/^(\s*)- \[x\]/gim, '$1- ☑');

  // Collapse HTML comments.
  out = out.replace(/<!--[\s\S]*?-->/g, '');

  return out.trim();
}

/**
 * Truncate to Discord's limit on a line boundary where possible, appending a link
 * back to the full text rather than silently losing the tail.
 */
export function truncateForDiscord(body: string, sourceUrl?: string): string {
  const suffix = sourceUrl ? `\n\n… [read the full comment on GitHub](${sourceUrl})` : '\n\n… _(truncated)_';
  if (body.length <= DISCORD_MAX) return body;

  const budget = DISCORD_MAX - suffix.length;
  let cut = body.slice(0, budget);

  // Prefer cutting at a paragraph, then a line, rather than mid-word.
  const lastPara = cut.lastIndexOf('\n\n');
  const lastLine = cut.lastIndexOf('\n');
  if (lastPara > budget * 0.5) cut = cut.slice(0, lastPara);
  else if (lastLine > budget * 0.7) cut = cut.slice(0, lastLine);

  return cut.trimEnd() + suffix;
}

/**
 * Player bug-report shorthand: "#medium: mobs are broken" -> priority + description.
 *
 * Matches the convention already used on every issue triaged by hand so far — see
 * the existing `priority-*` labels and issue bodies. `s` lets the description span
 * multiple lines (the prefix only has to open the message, not be the whole of it).
 */
const BUG_REPORT_PATTERN = /^#(low|medium|high|urgent)\s*:\s*(.+)$/is;

export type BugPriority = 'low' | 'medium' | 'high' | 'urgent';

export function parseBugReport(text: string): { priority: BugPriority; description: string } | null {
  const m = text.trim().match(BUG_REPORT_PATTERN);
  if (!m) return null;
  return { priority: m[1].toLowerCase() as BugPriority, description: m[2].trim() };
}

/**
 * Format a parsed bug report as a GitHub issue body.
 *
 * Deliberately mirrors the header ("**Priority:** …\n**Reported by:** … (Discord)")
 * already on every hand-triaged issue, so automated and manual reports read the same
 * way in the tracker.
 */
export function bugReportToGithub(opts: {
  priority: BugPriority;
  reportedBy: string;
  description: string;
  attachments?: { name: string; url: string }[];
}): string {
  const parts = [
    `**Priority:** ${opts.priority}`,
    `**Reported by:** ${opts.reportedBy} (Discord)`,
    '',
    opts.description,
  ];

  if (opts.attachments?.length) {
    parts.push('', '---', '**Attachments:**');
    for (const a of opts.attachments) parts.push(`- [${a.name}](${a.url})`);
  }

  return parts.join('\n');
}

/** Discord thread names are capped at 100 characters. */
export function threadName(issueNumber: number, title: string): string {
  const prefix = `#${issueNumber} `;
  const room = 100 - prefix.length;
  const t = title.length > room ? title.slice(0, room - 1) + '…' : title;
  return prefix + t;
}
