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

/**
 * A Discord app exposes several credentials and only one of them logs in a bot.
 * Pasting the Client Secret (OAuth2, ~32 chars) instead of the Bot Token yields
 * discord.js's `TokenInvalid`, which names neither the variable nor the mistake.
 * Bot tokens are three dot-separated parts; checking the shape turns a confusing
 * crash loop into a sentence that says what to do.
 */
function botToken(name: string): string {
  const v = required(name);
  if (v.split('.').length !== 3) {
    console.error(`${name} does not look like a bot token.`);
    console.error('');
    console.error('  Bot Token     three dot-separated parts, ~70 chars  <- this one');
    console.error('  Client Secret single ~32-char string (OAuth2, not for bots)');
    console.error('');
    console.error('Get it at: Developer Portal -> your app -> Bot -> Token -> Reset Token');
    console.error('(Discord shows it once; resetting is the only way to see it again.)');
    process.exit(1);
  }
  return v;
}

export const config = {
  port: Number(optional('PORT', '3000')),
  databasePath: optional('DATABASE_PATH', './bridge.db'),

  discord: {
    token: botToken('DISCORD_TOKEN'),
    guildId: required('DISCORD_GUILD_ID'),
    /** Forum channel: one thread per GitHub issue. */
    issueChannelId: required('DISCORD_ISSUE_CHANNEL_ID'),
    /** Text channel for development activity: PRs, build results, releases. */
    ciChannelId: required('DISCORD_CI_CHANNEL_ID'),
    /**
     * Text channel for things that are broken right now: monitor alerts and
     * failed builds on the default branch.
     *
     * Split from the CI channel because Discord's notification settings are
     * per-channel, and these two want opposite ones. Sharing a channel forces a
     * choice between muting a 3am outage and being pinged for every pull
     * request — and the outage is the one that loses, because the routine
     * traffic is what trains you to ignore it.
     *
     * Falls back to the CI channel when unset, so this behaves exactly as before
     * until the channel actually exists.
     */
    alertChannelId: optional('DISCORD_ALERT_CHANNEL_ID', '') || required('DISCORD_CI_CHANNEL_ID'),
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
