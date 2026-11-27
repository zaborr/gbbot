import { z } from 'zod';

/** Optional variable: an empty value counts as not set. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema.optional(),
  );

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  /**
   * The first bot. Once the server has run, the active bot is kept in the
   * database (it can be changed from the panel) and this can be removed. A
   * token changed here by hand takes over if Telegram accepts it.
   */
  BOT_TOKEN: optional(z.string().min(1)),
  /**
   * Key for the secrets kept in the database (bot tokens). Unset = derived
   * from JWT_SECRET.
   */
  BOTS_KEY: optional(z.string().min(16)),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  INITDATA_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(86_400),
  /** Platform super-admins: create shops, hide them and assign their admins. */
  ADMIN_TELEGRAM_IDS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => Number(part)),
    )
    .pipe(z.array(z.number().int().positive())),
  /**
   * Secret Telegram sends with each webhook call. Needed for the bot to answer
   * /start and to learn the groups it is added to; without it the webhook is off.
   */
  TELEGRAM_WEBHOOK_SECRET: optional(z.string().trim().min(1)),
  /**
   * Public address of this API, to register the Telegram webhook at startup.
   * Render sets RENDER_EXTERNAL_URL by itself, so it is rarely needed.
   */
  PUBLIC_URL: optional(z.url()),
  RENDER_EXTERNAL_URL: optional(z.url()),
  /**
   * Blockchain nodes used to check payments. Public nodes by default; set your
   * own (Alchemy, Helius, QuickNode…) if a network is slow or rate-limited.
   */
  RPC_BASE_URL: z.url().default('https://mainnet.base.org'),
  RPC_ETHEREUM_URL: z.url().default('https://ethereum-rpc.publicnode.com'),
  RPC_SOLANA_URL: z.url().default('https://api.mainnet-beta.solana.com'),
  CORS_ORIGIN: z.string().default('*'),
  /**
   * Web sign-in (username, password and authenticator code) of admins: on the
   * main domain and the .onion address. Set to "true" to allow it only through
   * the .onion address. Never on the customer-only domains (WEB_DOMAINS).
   */
  WEB_LOGIN_ONION_ONLY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /**
   * More domains for customers only (spaces or commas between them): the web
   * fallback for when the bot is down, if the main domain is blocked. Admins
   * cannot sign in there. Empty = none.
   */
  WEB_DOMAINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(/[\s,]+/)
        .map((d) => d.trim().replace(/^https?:\/\//, '').replace(/\/+$/, ''))
        .filter((d) => d !== '' && !d.endsWith('.invalid')),
    ),
  /**
   * "true": full platform web accounts sign in only through the .onion address;
   * linked ones (supervisors, organisers, GB teams) also on the main domain.
   */
  WEB_PLATFORM_ONION_ONLY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /**
   * "false": the message with a customer's web key leaves the main domain out
   * and links to the customer-only domains (WEB_DOMAINS) only. Ignored with no
   * WEB_DOMAINS.
   */
  WEB_KEY_MAIN_LINK: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  /**
   * The login bot: only for "Log in with Telegram" on the web (linking a web
   * account to its Telegram, signing in, a forgotten password). A bot of its
   * own, apart from the shop's, so it survives if that one is blocked. Its
   * domain is set in @BotFather (/setdomain). Empty = no Telegram button.
   */
  LOGIN_BOT_TOKEN: z.string().optional(),
  /** Its @username, without the @. */
  LOGIN_BOT_USERNAME: z.string().optional(),
  /** How long a customer's web account session lasts, in days. */
  WEB_ACCOUNT_SESSION_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  /** How long a web session lasts. */
  WEB_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(8 * 3600),
  /**
   * Address of the web panel, shown to managers when they activate their web
   * access in the app. Unset = they ask the platform admin for it.
   */
  WEB_ONION_URL: optional(z.url()),
  /** The creator service (see creator/README.md). */
  CREATOR_URL: z.url().default('http://creator:3100'),
  /** Folder shared with the server for /update (see deploy/auto-update). */
  UPDATE_DIR: optional(z.string()),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validates `process.env` once at startup and returns a typed, frozen config.
 * Throws with a readable message if anything required is missing.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return Object.freeze(parsed.data);
}
