import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import type { AppBindings } from '../context.js';
import { ApiError } from '../lib/errors.js';
import { peekUserId } from './shop.js';

/**
 * Limits how many requests one client makes per minute, so a script cannot
 * hammer the API (logins, orders, payments) or wear out a small server.
 * Counters live in memory: one API process, and a restart simply resets them.
 */

const WINDOW_MS = 60_000;

/** What a request counts against. */
interface Rule {
  name: string;
  limit: number;
  /** Counted per signed-in user (else per IP) or always per IP. */
  per: 'user' | 'ip';
}

const LOGIN: Rule = { name: 'login', limit: 20, per: 'ip' };
const PAYMENT: Rule = { name: 'payment', limit: 10, per: 'user' };
const WRITE: Rule = { name: 'write', limit: 60, per: 'user' };
const READ: Rule = { name: 'read', limit: 300, per: 'ip' };

/** Which rule a request falls under. */
export function ruleFor(method: string, path: string): Rule {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return READ;
  if (path.startsWith('/api/auth')) return LOGIN;
  if (/^\/api\/orders\/[^/]+\/(manual-)?payment$/.test(path)) return PAYMENT;
  return WRITE;
}

const counters = new Map<string, { count: number; resetAt: number }>();
let lastSweep = 0;

/** Counts one hit; returns the seconds to wait when the limit is passed, else 0. */
export function hit(key: string, limit: number, now = Date.now()): number {
  if (now - lastSweep > WINDOW_MS) {
    lastSweep = now;
    for (const [k, v] of counters) if (v.resetAt <= now) counters.delete(k);
  }
  const entry = counters.get(key);
  if (!entry || entry.resetAt <= now) {
    counters.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return 0;
  }
  entry.count += 1;
  return entry.count > limit ? Math.ceil((entry.resetAt - now) / 1000) : 0;
}

/** The client's IP as Caddy reports it (the API is only reachable through Caddy). */
function clientIp(c: Context<AppBindings>): string {
  const forwarded = c.req.header('X-Forwarded-For');
  const last = forwarded?.split(',').pop()?.trim();
  return last || c.req.header('X-Real-IP') || 'local';
}

export const rateLimit = createMiddleware<AppBindings>(async (c, next) => {
  // The test suite makes hundreds of requests from one "client".
  if (process.env.VITEST) return next();
  const rule = ruleFor(c.req.method, c.req.path);
  let who = `ip:${clientIp(c)}`;
  if (rule.per === 'user') {
    const userId = await peekUserId(c.req.header('Authorization'), c.get('env').JWT_SECRET);
    if (userId !== undefined) who = `user:${userId}`;
  }
  const wait = hit(`${rule.name}|${who}`, rule.limit);
  if (wait > 0) {
    c.header('Retry-After', String(wait));
    throw new ApiError(429, 'rate_limited', 'Too many requests. Wait a moment and try again.');
  }
  await next();
});
