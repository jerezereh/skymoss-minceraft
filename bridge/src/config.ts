/** Environment configuration, validated once at startup. */

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export const config = {
  port: Number(optional('PORT', '3000')),
  databasePath: optional('DATABASE_PATH', './bridge.db'),

  discord: {
    token: required('DISCORD_TOKEN'),
    guildId: required('DISCORD_GUILD_ID'),
    /** Forum channel: one thread per GitHub issue. */
    issueChannelId: required('DISCORD_ISSUE_CHANNEL_ID'),
    /** Text channel for CI/CD and release notifications. */
    ciChannelId: required('DISCORD_CI_CHANNEL_ID'),
  },

  github: {
    token: required('GITHUB_TOKEN'),
    repo: optional('GITHUB_REPO', 'jerezereh/skymoss-minceraft'),

    /**
     * Only needed when GitHub can actually deliver webhooks. With no public
     * hostname there is nowhere to deliver to, so this is optional and the
     * /webhook/github route is disabled when unset.
     */
    webhookSecret: optional('GITHUB_WEBHOOK_SECRET', ''),

    /**
     * Seconds between GitHub polls. 0 disables polling (use webhooks instead).
     * Both can run together — message_links dedups whichever arrives second.
     */
    pollIntervalSeconds: Number(optional('GITHUB_POLL_INTERVAL', '60')),
  },

  /** Shared secret for the CI /events endpoint. */
  ciEventSecret: required('CI_EVENT_SECRET'),

  /**
   * Bearer token for /alerts. Uptime Kuma and most monitoring tools send plain
   * unsigned webhooks, so that endpoint uses a bearer token rather than the HMAC
   * scheme used for CI events.
   */
  alertToken: optional('ALERT_TOKEN', ''),

  rcon: {
    host: optional('RCON_HOST', 'mc'),
    port: Number(optional('RCON_PORT', '25575')),
    password: optional('RCON_PASSWORD', ''),
  },

  /**
   * Role permitted to run /restart and /cmd. Unset means nobody can — /cmd is a full
   * server console, so it fails closed rather than open.
   */
  adminRoleId: optional('ADMIN_ROLE_ID', ''),
} as const;

export function repoParts(): { owner: string; repo: string } {
  const [owner, repo] = config.github.repo.split('/');
  return { owner, repo };
}
