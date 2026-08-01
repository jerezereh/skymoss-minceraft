/**
 * Discord side of the bridge.
 *
 * Relayed GitHub comments are posted through a channel webhook with a per-message
 * username and avatar override, so a comment from a GitHub user appears under that
 * user's name rather than all traffic arriving as one anonymous bot. This is what
 * makes the Discord side read like a conversation instead of a log feed.
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  WebhookClient,
  REST,
  Routes,
  type ForumChannel,
  type TextChannel,
  type ThreadChannel,
  type Message,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { config } from './config.ts';
import { threadName, truncateForDiscord } from './format.ts';
import { commandDefinitions } from './commands.ts';

const WEBHOOK_NAME = 'Skymoss Bridge';

export class DiscordSide {
  readonly client: Client;
  private webhookCache = new Map<string, WebhookClient>();

  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
  }

  async login(): Promise<void> {
    await this.client.login(config.discord.token);
    await new Promise<void>((resolve) => {
      if (this.client.isReady()) return resolve();
      this.client.once('clientReady', () => resolve());
    });
    console.log(`[discord] logged in as ${this.client.user?.tag}`);
  }

  /** The bot's own user id — used to ignore its own messages. */
  get botUserId(): string | undefined {
    return this.client.user?.id;
  }

  /**
   * Get (or lazily create) the webhook used to post as arbitrary users.
   * Webhooks live on the parent channel, not the thread; posting into a thread is
   * done with the threadId option.
   */
  private async getWebhook(channelId: string): Promise<WebhookClient> {
    const cached = this.webhookCache.get(channelId);
    if (cached) return cached;

    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('fetchWebhooks' in channel)) {
      throw new Error(`channel ${channelId} cannot host webhooks`);
    }

    const existing = await (channel as TextChannel).fetchWebhooks();
    let hook = existing.find((w) => w.name === WEBHOOK_NAME && w.token);
    if (!hook) {
      hook = await (channel as TextChannel).createWebhook({
        name: WEBHOOK_NAME,
        reason: 'Skymoss GitHub bridge relay',
      });
    }

    const wc = new WebhookClient({ id: hook.id, token: hook.token! });
    this.webhookCache.set(channelId, wc);
    return wc;
  }

  /** Create a forum thread for a GitHub issue. Returns the thread id. */
  async createIssueThread(opts: {
    issueNumber: number;
    title: string;
    body: string;
    author: string;
    avatarUrl?: string;
    url: string;
  }): Promise<{ threadId: string; channelId: string }> {
    const channel = await this.client.channels.fetch(config.discord.issueChannelId);
    if (!channel) throw new Error('issue channel not found');

    const name = threadName(opts.issueNumber, opts.title);
    const content = truncateForDiscord(
      `**${opts.author}** opened [#${opts.issueNumber}](${opts.url})\n\n${opts.body || '_(no description)_'}`,
      opts.url,
    );

    if (channel.type === ChannelType.GuildForum) {
      const post = await (channel as ForumChannel).threads.create({
        name,
        message: { content },
        reason: `GitHub issue #${opts.issueNumber}`,
      });
      return { threadId: post.id, channelId: config.discord.issueChannelId };
    }

    // Fall back to a text-channel thread if the configured channel is not a forum,
    // so a misconfigured channel type degrades instead of failing outright.
    const text = channel as TextChannel;
    const starter = await text.send({ content });
    const thread = await starter.startThread({ name, autoArchiveDuration: 10080 });
    return { threadId: thread.id, channelId: config.discord.issueChannelId };
  }

  /** Relay a GitHub comment into an issue thread, attributed to its GitHub author. */
  async postRelayedComment(opts: {
    threadId: string;
    channelId: string;
    author: string;
    avatarUrl?: string;
    body: string;
    sourceUrl: string;
  }): Promise<string> {
    const hook = await this.getWebhook(opts.channelId);
    const sent = await hook.send({
      threadId: opts.threadId,
      content: truncateForDiscord(opts.body, opts.sourceUrl),
      username: `${opts.author} (GitHub)`.slice(0, 80),
      avatarURL: opts.avatarUrl,
      allowedMentions: { parse: [] },
    });
    return sent.id;
  }

  /** Post a plain bot message into a thread (state changes, system notices). */
  async postSystemMessage(threadId: string, content: string): Promise<void> {
    const thread = (await this.client.channels.fetch(threadId)) as ThreadChannel | null;
    if (!thread?.isThread()) return;
    await thread.send({ content: truncateForDiscord(content), allowedMentions: { parse: [] } });
  }

  async setThreadArchived(threadId: string, archived: boolean): Promise<void> {
    const thread = (await this.client.channels.fetch(threadId)) as ThreadChannel | null;
    if (!thread?.isThread()) return;
    await thread.setArchived(archived).catch(() => {});
  }

  async postToCiChannel(content: string): Promise<void> {
    await this.postToChannel(config.discord.ciChannelId, content);
  }

  /** Things that are broken right now. See config.discord.alertChannelId. */
  async postToAlertChannel(content: string): Promise<void> {
    await this.postToChannel(config.discord.alertChannelId, content);
  }

  private async postToChannel(channelId: string, content: string): Promise<void> {
    const channel = (await this.client.channels.fetch(channelId)) as TextChannel | null;
    if (!channel) return;
    await channel.send({ content: truncateForDiscord(content), allowedMentions: { parse: [] } });
  }

  onMessage(handler: (msg: Message) => Promise<void>): void {
    this.client.on('messageCreate', (msg) => {
      handler(msg).catch((err) => console.error('[discord] handler error:', err));
    });
  }

  /**
   * Register slash commands against the guild rather than globally: guild commands
   * appear immediately, while global ones can take up to an hour to propagate.
   */
  async registerCommands(): Promise<void> {
    const rest = new REST({ version: '10' }).setToken(config.discord.token);
    const appId = this.client.application?.id ?? this.client.user?.id;
    if (!appId) throw new Error('cannot determine application id');

    await rest.put(Routes.applicationGuildCommands(appId, config.discord.guildId), {
      body: commandDefinitions,
    });
    console.log(`[discord] registered ${commandDefinitions.length} slash commands`);
  }

  onCommand(handler: (interaction: ChatInputCommandInteraction) => Promise<void>): void {
    this.client.on('interactionCreate', (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      handler(interaction).catch(async (err) => {
        console.error('[discord] command error:', err);
        // An interaction that is never answered shows "application did not respond",
        // which is less useful than saying something went wrong.
        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply('❌ Something went wrong running that command.');
          } else {
            await interaction.reply({ content: '❌ Something went wrong.', ephemeral: true });
          }
        } catch {
          /* interaction already expired */
        }
      });
    });
  }

  async destroy(): Promise<void> {
    for (const w of this.webhookCache.values()) w.destroy();
    await this.client.destroy();
  }
}
