import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  cloneProductsRequest,
  MANUAL_METHOD_PREFIX,
  RATE_SCALE,
  updateGoalRequest,
  type ManualPaymentMethod,
  exportRequest,
  langFrom,
  productInput,
  shopProfileInput,
  slug,
  updateAddressKeyRequest,
  updateAutoCancelRequest,
  updateOverpayMarginRequest,
  updateShopCurrencyRequest,
  updateOrderFeeRequest,
  updateOrderStatusRequest,
  updateShippingRequest,
  updatePaymentSetupRequest,
  updateVipClubRequest,
  updateClosingRequest,
  ownerSettingsInput,
  duplicateShopRequest,
  productsCsvRequest,
  broadcastAudience,
  sendBroadcastRequest,
  updateDisclaimerRequest,
  type WebFile,
  type Order,
  addToBlacklistRequest,
  blacklistWho,
} from '@tma-shop/shared';
import type { Context } from 'hono';
import type { AppBindings } from '../context.js';
import { requireAdmin, requireAuth, requireOwner } from '../auth/middleware.js';
import {
  createCategory,
  createProduct,
  deleteCategory,
  deleteAllProducts,
  deleteProduct,
  listAllProducts,
  updateCategory,
  updateProduct,
} from '../services/admin.js';
import {
  approveOrderChange,
  changeOrderStatus,
  clearOrderChange,
  deleteOrder,
  getOrder,
  listAllOrders,
  recordRefund,
} from '../services/orders.js';
import {
  buildChangeDecisionMessage,
  buildStatusMessage,
  notifyUsers,
} from '../services/notifications.js';
import {
  deleteShopWithEverything,
  getShopAdminView,
  isSuperAdmin,
  shopContents,
  updateOwnerSettings,
  updateAddressKey,
  updateAutoCancel,
  updateOverpayMargin,
  updateShopCurrency,
  updateOrderFee,
  updateShippingZones,
  updateShopProfile,
  updatePaymentSetup,
} from '../services/shop.js';
import { ApiError } from '../lib/errors.js';
import { orders, users } from '../db/schema.js';
import { startPaymentCheck } from '../services/paymentCheck.js';
import { buildReport } from '../export/report.js';
import { TelegramApi } from '../telegram/api.js';
import { isWebSession, webMark } from '../services/webAdmins.js';
import type { SessionClaims } from '../auth/jwt.js';
import { notifyShopTeam } from '../services/webNotices.js';
import {
  addToShopBlacklist,
  blockedAmong,
  checkBlacklist,
  removeFromShopBlacklist,
  shopBlacklistView,
  withoutBlocked,
} from '../services/blacklist.js';
import { tr } from '../i18n/messages.js';
import { describeCustomer } from '../services/customers.js';
import { shopVipClubView, updateShopVipClub } from '../services/vip.js';
import { cloneProducts, listCloneSources } from '../services/clone.js';
import { closePreview, closeShop, reopenShop, scheduleClosing } from '../services/closing.js';
import { announceGoalMilestones, updateGoal } from '../services/goal.js';
import { getShopTeam, notifySuperAdmins } from '../services/team.js';
import { restoreSnapshot, takeSnapshot } from '../services/snapshot.js';
import { audienceIds, listBroadcasts, startBroadcast } from '../services/broadcast.js';
import { getDisclaimerAdmin, updateDisclaimer } from '../services/disclaimer.js';
import { deleteLater } from '../services/expiringMessages.js';
import {
  exportProductsCsv,
  importProductsCsv,
  previewProductsCsv,
} from '../services/productsCsv.js';

const idParam = z.object({ id: z.uuid() });

/**
 * Manual methods (Wise, Bizum…) added, removed or with new instructions: like
 * a wallet address, the instructions say where the money goes.
 */
export function manualMethodChanges(
  before: readonly ManualPaymentMethod[],
  after: readonly ManualPaymentMethod[],
): { name: string; instructions: string | null }[] {
  const changes: { name: string; instructions: string | null }[] = [];
  for (const m of after) {
    const old = before.find((b) => b.id === m.id);
    if (!old || old.instructions !== m.instructions || old.name !== m.name) {
      changes.push({ name: m.name, instructions: m.instructions });
    }
  }
  for (const m of before) {
    if (!after.some((a) => a.id === m.id)) changes.push({ name: m.name, instructions: null });
  }
  return changes;
}

/**
 * Hands a generated file to the admin: the bot sends it to their chat, or for
 * a web administrator it comes back in the response.
 */
async function deliverFile(
  env: { BOT_TOKEN: string },
  claims: SessionClaims,
  file: { fileName: string; data: Buffer; contentType: string; caption: string },
): Promise<{ file?: WebFile }> {
  if (isWebSession(claims)) {
    return {
      file: {
        fileName: file.fileName,
        contentType: file.contentType,
        data: file.data.toString('base64'),
      },
    };
  }
  try {
    const telegram = new TelegramApi(env.BOT_TOKEN);
    await telegram.sendDocument(
      claims.sub,
      file.fileName,
      file.data,
      file.contentType,
      file.caption,
    );
  } catch (error) {
    console.error(`${file.fileName} could not be sent:`, error);
    throw ApiError.conflict(
      'send_failed',
      'The bot could not send you the file. Open your chat with the bot, press Start, and try again.',
    );
  }
  return {};
}

/** The customer's chat: none once the order is anonymized, or if they are blacklisted. */
async function customerChat(
  c: Context<AppBindings>,
  order: { userId: number | null },
): Promise<number[]> {
  if (order.userId === null) return [];
  return withoutBlocked(c.get('db'), c.get('env'), c.get('shop'), [order.userId]);
}
const categoryInput = z.object({
  slug,
  title: z.string().min(1).max(128),
  sortOrder: z.number().int().default(0),
});

export function adminRoutes(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use('*', requireAuth, requireAdmin);

  // Shop settings (admin view includes the payment setup and admin ids).
  app.get('/shop', (c) => c.json(getShopAdminView(c.get('shop'))));
  // Closing the GB: no new orders, existing ones can still be managed.
  app.get('/shop/close-preview', async (c) =>
    c.json(await closePreview(c.get('db'), c.get('shopId'))),
  );
  app.post('/shop/close', async (c) =>
    c.json(getShopAdminView(await closeShop(c.get('db'), c.get('env'), c.get('shop')))),
  );
  app.post('/shop/reopen', async (c) =>
    c.json(getShopAdminView(await reopenShop(c.get('db'), c.get('shop')))),
  );
  // The minimum for the GB to go ahead (any manager, like the closing date).
  app.put('/shop/goal', zValidator('json', updateGoalRequest), async (c) => {
    const { amount, showAmount } = c.req.valid('json');
    return c.json(getShopAdminView(await updateGoal(c.get('db'), c.get('shopId'), amount, showAmount)));
  });
  app.put('/shop/closing', zValidator('json', updateClosingRequest), async (c) => {
    const { closesAt, warnHours } = c.req.valid('json');
    return c.json(
      getShopAdminView(
        await scheduleClosing(
          c.get('db'),
          c.get('shop'),
          closesAt ? new Date(closesAt) : null,
          warnHours,
        ),
      ),
    );
  });

  // The text customers accept before entering the GB.
  app.get('/shop/disclaimer', async (c) => c.json(await getDisclaimerAdmin(c.get('db'), c.get('shop'))));
  app.put('/shop/disclaimer', zValidator('json', updateDisclaimerRequest), async (c) =>
    c.json(await updateDisclaimer(c.get('db'), c.get('shop'), c.req.valid('json'))),
  );

  /*
   * Shipping list sent by the bot (the admin's choice, after a warning): the
   * device decrypts the addresses and sends the CSV, which is passed on to
   * Telegram without being stored or logged here. The bot deletes it from the
   * chat after 24 hours.
   */
  app.post(
    '/shipping-list/send',
    zValidator(
      'json',
      z.object({
        fileName: z.string().regex(/^[\w.-]{1,100}\.csv$/),
        csv: z.string().min(1).max(2_000_000),
        count: z.number().int().nonnegative().max(100_000),
      }),
    ),
    async (c) => {
      const { fileName, csv, count } = c.req.valid('json');
      const shop = c.get('shop');
      const lang = langFrom(c.req.header('X-Lang'));
      const sub = c.get('claims').sub;
      // Web administrators save the list on their device instead.
      if (isWebSession(c.get('claims'))) throw ApiError.forbidden('Only available in Telegram');
      let sent: unknown;
      try {
        sent = await new TelegramApi(c.get('env').BOT_TOKEN).sendDocument(
          sub,
          fileName,
          Buffer.from(csv, 'utf8'),
          'text/csv',
          tr(lang, 'export.shippingCaption', { shop: shop.name, count }),
        );
      } catch {
        // Not the error itself: it could carry part of the file.
        console.error('Shipping list could not be sent to the admin chat.');
        throw ApiError.conflict(
          'send_failed',
          'The bot could not send you the file. Open your chat with the bot, press Start, and try again.',
        );
      }
      const messageId = (sent as { message_id?: number } | null)?.message_id;
      if (typeof messageId === 'number') await deleteLater(c.get('db'), sub, messageId);
      return c.json({ sent: true });
    },
  );

  // Messages to the GB's buyers through the bot: how many would get it, send, history.
  app.get(
    '/broadcasts/count',
    zValidator('query', z.object({ audience: broadcastAudience })),
    async (c) =>
      c.json({
        count: (
          await audienceIds(c.get('db'), c.get('env'), c.get('shop'), c.req.valid('query').audience)
        ).length,
      }),
  );
  app.get('/broadcasts', async (c) => c.json(await listBroadcasts(c.get('db'), c.get('shopId'))));
  app.post('/broadcasts', zValidator('json', sendBroadcastRequest), async (c) => {
    const { audience, text } = c.req.valid('json');
    return c.json(
      await startBroadcast(c.get('db'), c.get('env'), c.get('shop'), c.get('claims').sub, audience, text),
      201,
    );
  });

  // Administrators only: who runs the GB, who sees it, and deleting it.
  app.get('/shop/team', requireOwner, async (c) =>
    c.json(await getShopTeam(c.get('db'), c.get('shop'))),
  );
  app.put('/shop/owner', requireOwner, zValidator('json', ownerSettingsInput), async (c) => {
    const db = c.get('db');
    const env = c.get('env');
    const { before, after } = await updateOwnerSettings(
      db,
      c.get('shopId'),
      c.req.valid('json'),
      isSuperAdmin(env, c.get('claims').sub),
    );
    // A change of team is reported to every administrator, old and new.
    const same = (a: readonly unknown[], b: readonly unknown[]): boolean =>
      a.length === b.length && a.every((x) => b.includes(x));
    if (
      !same(before.ownerIds, after.ownerIds) ||
      !same(before.ownerUsernames, after.ownerUsernames) ||
      !same(before.adminIds, after.adminIds) ||
      !same(before.adminUsernames, after.adminUsernames)
    ) {
      const who = webMark(await describeCustomer(db, c.get('claims').sub), c.get('claims'));
      const team = await getShopTeam(db, after);
      const name = (p: { telegramId: number; username: string | null; firstName: string | null }): string =>
        p.username ? `@${p.username}` : (p.firstName ?? String(p.telegramId));
      const list = (people: string[]): string => (people.length > 0 ? people.join(', ') : '—');
      const owners = list([...team.owners.map(name), ...team.pendingOwnerUsernames.map((u) => `@${u}`)]);
      const managers = list([...team.admins.map(name), ...team.pendingUsernames.map((u) => `@${u}`)]);
      const recipients = [...new Set([...before.ownerIds, ...after.ownerIds])];
      await notifyUsers(db, env.BOT_TOKEN, recipients, (lang) =>
        [
          tr(lang, 'team.changed', { shop: after.name, who }),
          '',
          tr(lang, 'team.owners', { list: owners }),
          tr(lang, 'team.admins', { list: managers }),
        ].join('\n'),
      );
    }
    return c.json(getShopAdminView(after));
  });
  app.get('/shop/contents', requireOwner, async (c) =>
    c.json(await shopContents(c.get('db'), c.get('shopId'))),
  );
  app.post(
    '/shop/delete-all',
    requireOwner,
    zValidator('json', z.object({ confirmName: z.string().min(1).max(128) })),
    async (c) => {
      const shop = c.get('shop');
      const contents = await deleteShopWithEverything(
        c.get('db'),
        shop.id,
        c.req.valid('json').confirmName,
      );
      await notifySuperAdmins(c.get('db'), c.get('env'), c.get('claims'), 'platform.gbDeleted', {
        shop: shop.name,
        orders: contents.orders,
      });
      return c.json(contents);
    },
  );

  // Owner only: a new, hidden GB with the same settings and catalog (no orders).
  app.post('/shop/duplicate', requireOwner, zValidator('json', duplicateShopRequest), async (c) => {
    const db = c.get('db');
    const { sub } = c.get('claims');
    const { name, slug: newSlug } = c.req.valid('json');
    const copy = await restoreSnapshot(db, await takeSnapshot(db, c.get('shop')), {
      name,
      slug: newSlug,
      ownerId: sub,
    });
    await notifySuperAdmins(db, c.get('env'), c.get('claims'), 'platform.gbCreated', {
      shop: copy.name,
      slug: copy.slug,
    });
    return c.json(getShopAdminView(copy), 201);
  });

  // Owner only: the bot sends a backup of the GB (settings and catalog, no orders) as JSON.
  app.post('/shop/backup', requireOwner, async (c) => {
    const shop = c.get('shop');
    const lang = langFrom(c.req.header('X-Lang'));
    const snapshot = await takeSnapshot(c.get('db'), shop);
    const fileName = `${shop.slug}-backup-${snapshot.exportedAt.slice(0, 10)}.json`;
    const delivered = await deliverFile(c.get('env'), c.get('claims'), {
      fileName,
      data: Buffer.from(JSON.stringify(snapshot, null, 2), 'utf8'),
      contentType: 'application/json',
      caption: tr(lang, 'export.backupCaption', { shop: shop.name }),
    });
    return c.json({ fileName, products: snapshot.products.length, ...delivered });
  });

  // Copy products from another shop the user manages.
  app.get('/clone-sources', async (c) =>
    c.json(
      await listCloneSources(c.get('db'), c.get('env'), c.get('claims').sub, c.get('shopId')),
    ),
  );
  app.post('/clone', zValidator('json', cloneProductsRequest), async (c) =>
    c.json(
      await cloneProducts(
        c.get('db'),
        c.get('env'),
        c.get('claims').sub,
        c.get('shopId'),
        c.req.valid('json'),
      ),
    ),
  );

  // The shop's own VIP club.
  app.get('/shop/vip-club', (c) => c.json(shopVipClubView(c.get('shop'))));
  app.put('/shop/vip-club', zValidator('json', updateVipClubRequest), async (c) =>
    c.json(
      await updateShopVipClub(c.get('db'), c.get('env'), c.get('shop'), c.req.valid('json')),
    ),
  );
  app.put('/shop/profile', zValidator('json', shopProfileInput), async (c) =>
    c.json(await updateShopProfile(c.get('db'), c.get('shopId'), c.req.valid('json'))),
  );
  // Receiving addresses and accepted networks. Any address change is reported
  // to every admin of the shop and to the platform admins.
  app.put('/shop/payments', requireOwner, zValidator('json', updatePaymentSetupRequest), async (c) => {
    const db = c.get('db');
    const env = c.get('env');
    const shop = c.get('shop');
    const { before, view } = await updatePaymentSetup(db, shop.id, c.req.valid('json'));
    const after = view.paymentSetup;
    const manualChanges = manualMethodChanges(before.manual ?? [], after.manual ?? []);
    // Exchange rates decide how much of the other token pays an order: reported too.
    const rate = (value: number | null | undefined): string =>
      value ? String(value / RATE_SCALE) : '—';
    const rateChanges = (['EURC', 'USDC'] as const).filter(
      (token) => (before.exchange?.[token] ?? null) !== (after.exchange?.[token] ?? null),
    );
    if (
      before.evmAddress !== after.evmAddress ||
      before.solanaAddress !== after.solanaAddress ||
      manualChanges.length > 0 ||
      rateChanges.length > 0
    ) {
      const who = webMark(await describeCustomer(db, c.get('claims').sub), c.get('claims'));
      await notifyShopTeam(
        db,
        env,
        shop,
        (lang) =>
          [
            tr(lang, 'wallets.changed', { shop: shop.name, who }),
            '',
            tr(lang, 'wallets.evm', {
              before: before.evmAddress ?? '—',
              after: after.evmAddress ?? '—',
            }),
            tr(lang, 'wallets.solana', {
              before: before.solanaAddress ?? '—',
              after: after.solanaAddress ?? '—',
            }),
            ...manualChanges.map((m) =>
              m.instructions === null
                ? tr(lang, 'wallets.manualRemoved', { name: m.name })
                : tr(lang, 'wallets.manual', { name: m.name, instructions: m.instructions }),
            ),
            ...rateChanges.map((token) =>
              tr(lang, 'wallets.rate', {
                from: token,
                to: token === 'EURC' ? 'USDC' : 'EURC',
                before: rate(before.exchange?.[token]),
                after: rate(after.exchange?.[token]),
              }),
            ),
            '',
            tr(lang, 'wallets.checkIt'),
          ].join('\n'),
        { platformToo: true },
      );
    }
    return c.json(view);
  });
  // Shipping zones (flat cost per order) and the address encryption public key.
  app.put('/shop/shipping', zValidator('json', updateShippingRequest), async (c) => {
    const { zones, vipNoShipping } = c.req.valid('json');
    return c.json(await updateShippingZones(c.get('db'), c.get('shopId'), zones, vipNoShipping));
  });
  app.put('/shop/address-key', requireOwner, zValidator('json', updateAddressKeyRequest), async (c) => {
    const db = c.get('db');
    const env = c.get('env');
    const shop = c.get('shop');
    const view = await updateAddressKey(db, shop.id, c.req.valid('json').publicKey);
    // Like the wallets: every admin hears when the key that protects addresses changes.
    if (shop.addressKeyFingerprint !== view.addressKeyFingerprint) {
      const who = webMark(await describeCustomer(db, c.get('claims').sub), c.get('claims'));
      await notifyShopTeam(
        db,
        env,
        shop,
        (lang) =>
          [
            tr(lang, 'addressKey.changed', { shop: shop.name, who }),
            '',
            tr(lang, 'addressKey.fingerprint', {
              before: shop.addressKeyFingerprint ?? '—',
              after: view.addressKeyFingerprint ?? '—',
            }),
            '',
            tr(lang, 'addressKey.checkIt'),
          ].join('\n'),
        { platformToo: true },
      );
    }
    return c.json(view);
  });
  // Unpaid orders are cancelled after this many hours (0 = never).
  app.put('/shop/auto-cancel', zValidator('json', updateAutoCancelRequest), async (c) =>
    c.json(await updateAutoCancel(c.get('db'), c.get('shopId'), c.req.valid('json').hours)),
  );
  // The GB's currency (administrators): the minimum, the margin and new products use it.
  app.put('/shop/currency', requireOwner, zValidator('json', updateShopCurrencyRequest), async (c) =>
    c.json(await updateShopCurrency(c.get('db'), c.get('shopId'), c.req.valid('json').currency)),
  );
  // Overpayment margin (administrators): a little too much counts as the price.
  app.put(
    '/shop/overpay-margin',
    requireOwner,
    zValidator('json', updateOverpayMarginRequest),
    async (c) => {
      const db = c.get('db');
      const shop = c.get('shop');
      const { amount } = c.req.valid('json');
      const view = await updateOverpayMargin(db, shop.id, amount);
      if (amount !== shop.overpayMargin) {
        const who = webMark(await describeCustomer(db, c.get('claims').sub), c.get('claims'));
        const money = (value: number): string => `${(value / 100).toFixed(2)} ${shop.currency}`;
        await notifyShopTeam(
          db,
          c.get('env'),
          shop,
          (lang) =>
            tr(lang, 'payments.marginChanged', {
              who,
              shop: shop.name,
              before: money(shop.overpayMargin),
              after: money(amount),
            }),
          { platformToo: true },
        );
      }
      return c.json(view);
    },
  );
  // Fixed fee added once to every new order (0 hides it).
  app.put('/shop/fee', zValidator('json', updateOrderFeeRequest), async (c) =>
    c.json(await updateOrderFee(c.get('db'), c.get('shopId'), c.req.valid('json'))),
  );

  // Products
  app.get('/products', async (c) => c.json(await listAllProducts(c.get('db'), c.get('shopId'))));

  // Products as CSV: the bot sends the file; importing shows a preview first.
  app.post('/products/csv/export', async (c) => {
    const shop = c.get('shop');
    const lang = langFrom(c.req.header('X-Lang'));
    const file = await exportProductsCsv(c.get('db'), shop, lang);
    const delivered = await deliverFile(c.get('env'), c.get('claims'), {
      fileName: file.fileName,
      data: file.data,
      contentType: 'text/csv',
      caption: tr(lang, 'export.productsCaption', { shop: shop.name, count: file.count }),
    });
    return c.json({ fileName: file.fileName, products: file.count, ...delivered });
  });
  app.post('/products/csv/preview', zValidator('json', productsCsvRequest), async (c) =>
    c.json(await previewProductsCsv(c.get('db'), c.get('shop'), c.req.valid('json').csv)),
  );
  app.post('/products/csv/import', zValidator('json', productsCsvRequest), async (c) =>
    c.json(await importProductsCsv(c.get('db'), c.get('shop'), c.req.valid('json').csv)),
  );
  app.post('/products', zValidator('json', productInput), async (c) =>
    c.json(await createProduct(c.get('db'), c.get('shopId'), c.req.valid('json')), 201),
  );
  app.put(
    '/products/:id',
    zValidator('param', idParam),
    zValidator('json', productInput),
    async (c) =>
      c.json(
        await updateProduct(
          c.get('db'),
          c.get('shopId'),
          c.req.valid('param').id,
          c.req.valid('json'),
        ),
      ),
  );
  // Administrators only: the whole catalog at once.
  app.post(
    '/products/delete-all',
    requireOwner,
    zValidator('json', z.object({ confirmCount: z.number().int().nonnegative() })),
    async (c) =>
      c.json(await deleteAllProducts(c.get('db'), c.get('shopId'), c.req.valid('json').confirmCount)),
  );
  app.delete('/products/:id', zValidator('param', idParam), async (c) => {
    await deleteProduct(c.get('db'), c.get('shopId'), c.req.valid('param').id);
    return c.body(null, 204);
  });

  // Categories
  app.post('/categories', zValidator('json', categoryInput), async (c) =>
    c.json(await createCategory(c.get('db'), c.get('shopId'), c.req.valid('json')), 201),
  );
  app.put(
    '/categories/:id',
    zValidator('param', idParam),
    zValidator('json', categoryInput),
    async (c) =>
      c.json(
        await updateCategory(
          c.get('db'),
          c.get('shopId'),
          c.req.valid('param').id,
          c.req.valid('json'),
        ),
      ),
  );
  app.delete('/categories/:id', zValidator('param', idParam), async (c) => {
    await deleteCategory(c.get('db'), c.get('shopId'), c.req.valid('param').id);
    return c.body(null, 204);
  });

  // Orders
  // Orders of blacklisted customers are marked for the team.
  const markBlocked = async (c: Context<AppBindings>, list: Order[]): Promise<Order[]> => {
    const ids = list.flatMap((o) => (o.userId === null ? [] : [o.userId]));
    const blocked = await blockedAmong(c.get('db'), c.get('env'), c.get('shop'), ids);
    return list.map((o) =>
      o.userId !== null && blocked.has(o.userId) ? { ...o, customerBlocked: true } : o,
    );
  };
  app.get('/orders', async (c) =>
    c.json(await markBlocked(c, await listAllOrders(c.get('db'), c.get('shopId')))),
  );
  app.get('/orders/:id', zValidator('param', idParam), async (c) => {
    const order = await getOrder(c.get('db'), c.get('shopId'), c.req.valid('param').id);
    if (!order) throw ApiError.notFound('Order not found');
    const [marked] = await markBlocked(c, [order]);
    return c.json(marked ?? order);
  });

  // Blacklist of the GB (administrators): for those in it the GB does not exist.
  app.get('/blacklist', requireOwner, async (c) =>
    c.json(await shopBlacklistView(c.get('db'), c.get('shop'))),
  );
  app.post('/blacklist/check', requireOwner, zValidator('json', blacklistWho), async (c) =>
    c.json(await checkBlacklist(c.get('db'), c.req.valid('json').who, c.get('shopId'))),
  );
  app.post('/blacklist', requireOwner, zValidator('json', addToBlacklistRequest), async (c) => {
    const { who, removeData } = c.req.valid('json');
    return c.json(await addToShopBlacklist(c.get('db'), c.get('env'), c.get('shop'), who, removeData));
  });
  app.post('/blacklist/remove', requireOwner, zValidator('json', blacklistWho), async (c) =>
    c.json(await removeFromShopBlacklist(c.get('db'), c.get('shop'), c.req.valid('json').who)),
  );
  app.patch(
    '/orders/:id',
    zValidator('param', idParam),
    zValidator('json', updateOrderStatusRequest),
    async (c) => {
      const shop = c.get('shop');
      const { order, previous } = await changeOrderStatus(
        c.get('db'),
        shop.id,
        c.req.valid('param').id,
        c.req.valid('json'),
      );
      // The customer hears about it from the bot (best effort).
      if (order.status !== previous) {
        await notifyUsers(c.get('db'), c.get('env').BOT_TOKEN, await customerChat(c, order), (lang) =>
          buildStatusMessage(lang, shop.name, order, previous),
        );
        // A confirmed payment may pass a milestone of the GB's minimum.
        if (order.status === 'paid') await announceGoalMilestones(c.get('db'), c.get('env'), shop.id);
      }
      return c.json(order);
    },
  );

  // Reports: the bot sends the file (Excel or CSV) to the admin's own chat.
  app.post('/export', zValidator('json', exportRequest), async (c) => {
    const db = c.get('db');
    const shop = c.get('shop');
    const request = c.req.valid('json');

    const allOrders = await listAllOrders(db, shop.id);
    const ids = [...new Set(allOrders.flatMap((o) => (o.userId === null ? [] : [o.userId])))];
    const people =
      ids.length > 0 ? await db.select().from(users).where(inArray(users.telegramId, ids)) : [];
    const customers = new Map(
      people.map((u) => [
        u.telegramId,
        { name: u.firstName, username: u.username },
      ]),
    );

    // Same language as the app the admin is using.
    const lang = langFrom(c.req.header('X-Lang'));
    const file = buildReport({
      shopName: shop.name,
      shopSlug: shop.slug,
      feeLabel: shop.orderFeeLabel,
      orders: allOrders,
      customers,
      request,
      lang,
    });
    if (file.orderCount === 0) {
      throw ApiError.badRequest('nothing_to_export', 'No orders match these filters');
    }
    const delivered = await deliverFile(c.get('env'), c.get('claims'), {
      fileName: file.fileName,
      data: file.data,
      contentType: file.contentType,
      caption: tr(lang, file.orderCount === 1 ? 'export.captionOne' : 'export.captionOther', {
        shop: shop.name,
        count: file.orderCount,
      }),
    });
    return c.json({ fileName: file.fileName, orders: file.orderCount, ...delivered });
  });

  // Customer change requests: approve (apply + tell them what to pay) or reject.
  app.post('/orders/:id/change/approve', zValidator('param', idParam), async (c) => {
    const order = await approveOrderChange(c.get('db'), c.get('shopId'), c.req.valid('param').id);
    await notifyUsers(c.get('db'), c.get('env').BOT_TOKEN, await customerChat(c, order), (lang) =>
      buildChangeDecisionMessage(lang, order, true),
    );
    return c.json(order);
  });
  app.post('/orders/:id/change/reject', zValidator('param', idParam), async (c) => {
    const order = await clearOrderChange(c.get('db'), c.get('shopId'), c.req.valid('param').id);
    await notifyUsers(c.get('db'), c.get('env').BOT_TOKEN, await customerChat(c, order), (lang) =>
      buildChangeDecisionMessage(lang, order, false),
    );
    return c.json(order);
  });

  // Check the submitted transaction on the blockchain again.
  app.post('/orders/:id/recheck', zValidator('param', idParam), async (c) => {
    const db = c.get('db');
    const [row] = await db
      .update(orders)
      .set({
        paymentCheck: { status: 'checking', reason: null, vars: null, at: new Date().toISOString() },
      })
      .where(
        and(
          eq(orders.shopId, c.get('shopId')),
          eq(orders.id, c.req.valid('param').id),
          eq(orders.status, 'awaiting_payment'),
          isNotNull(orders.paymentMethodId),
          // Manual methods (Wise, Bizum…) have nothing to check on-chain.
          sql`${orders.paymentMethodId} NOT LIKE ${`${MANUAL_METHOD_PREFIX}%`}`,
        ),
      )
      .returning({ id: orders.id });
    if (!row) {
      throw ApiError.conflict('not_checkable', 'Only orders with a payment under review can be checked');
    }
    startPaymentCheck(db, c.get('env'), row.id);
    const order = await getOrder(db, c.get('shopId'), row.id);
    return c.json(order);
  });

  // The admin sent the overpaid difference back to the customer.
  app.post('/orders/:id/refund', zValidator('param', idParam), async (c) =>
    c.json(await recordRefund(c.get('db'), c.get('shopId'), c.req.valid('param').id)),
  );

  app.delete('/orders/:id', zValidator('param', idParam), async (c) => {
    await deleteOrder(c.get('db'), c.get('shopId'), c.req.valid('param').id);
    return c.body(null, 204);
  });

  return app;
}
