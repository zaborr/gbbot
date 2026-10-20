import type { Env } from './config/env.js';
import type { Database } from './db/client.js';
import type { SessionClaims } from './auth/jwt.js';
import type { ShopRow } from './services/shop.js';

/** Dependencies shared across the whole API, injected at app construction. */
export interface AppDeps {
  env: Env;
  db: Database;
}

/** Hono context variables available to handlers and middleware. */
export interface AppVariables {
  env: Env;
  db: Database;
  /** Id of the shop this request is for (`X-Shop` header). */
  shopId: string;
  /** The shop row itself. */
  shop: ShopRow;
  /** Whether the caller (if signed in) is this shop's admin or a super-admin. */
  canManage: boolean;
  /** Whether the caller has owner powers here (owner organiser or super-admin). */
  canOwn: boolean;
  /** The GB has a disclaimer the caller has not accepted yet (admins never do). */
  disclaimerPending: boolean;
  /** Whether the caller is in this shop's VIP club (only checked for VIP-only shops). */
  isVip: boolean;
  /** Present only on routes behind the auth middleware. */
  claims: SessionClaims;
}

export interface AppBindings {
  Variables: AppVariables;
}
