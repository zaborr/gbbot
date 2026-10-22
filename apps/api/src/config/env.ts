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
  BOT_TOKEN: z.string().min(1),
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
   * Web sign-in (username, password and authenticator code) is accepted only
   * through the Tor .onion address. Set to "false" to allow it anywhere.
   */
  WEB_LOGIN_ONION_ONLY: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  /** How long a web session lasts. */
  WEB_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(8 * 3600),
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
