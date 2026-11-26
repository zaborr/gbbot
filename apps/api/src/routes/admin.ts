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
  updateShipmentRequest,
  reduceOrderRequest,
  reducePreviewRequest,
  updateShippingRequest,
  updateCheckoutFieldsRequest,
  updatePaymentSetupRequest,
  updateVipClubRequest,
  updateClosingRequest,
  ownerSettingsInput,
  duplicateShopRequest,
  productsCsvRequest,
  BROADCAST_MAX_LENGTH,
  broadcastAudience,
  labRequest,
  sendBroadcastRequest,
  updateDisclaimerRequest,
  type WebFile,
  type Order,
  addToBlacklistRequest,
  blacklistWho,
  updateTestingEnabledRequest,
  adminCreateOrderRequest,
  labelRequest,
  labelRequests,
} from '@tma-shop/shared';
import type { Context } from 'hono';
import type { AppBindings } from '../context.js';
import { requireAdmin, requireAuth, requireOwner } from '../auth/middleware.js';
import { imageUrl, saveImage } from '../services/images.js';
import { labelFile, requestLabel, requestLabels, sendLabelTo } from '../services/labels.js';
import { createOrderFor, listPendingOrders, removePendingOrder } from '../services/adminOrders.js';
import { addCustomer, giveKey, keyOf, revokeKeys } from '../services/webKeys.js';
import { testingAdminRoutes } from './testing.js';
import { announceTestingTiers, listTestings, markTestings, setTestingEnabled } from '../services/testing.js';
import { unpaidExtras } from '../services/testingExtra.js';
import { createLab, deleteLab, listLabs, updateLab } from '../services/labs.js';
import { pendingRefunds } from '../services/refunds.js';
import { findReport, listReports, reportCaption, reportFile, sendReportTo } from '../services/testingReports.js';
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
  recentCarriers,
  updateShipment,
  reduceOrder,
  previewReduceOrder,
  clearOrderChange,
  deleteOrder,
  getOrder,
  listAllOrders,
  recordRefund,
} from '../services/orders.js';
import {
  buildChangeDecisionMessage,
  buildStatusMessage,
  shipmentLine,
  money as formatMoney,
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
  updateCheckoutFields,
  updateShopProfile,
  updatePaymentSetup,
} from '../services/shop.js';
import { ApiError } from '../lib/errors.js';
import { orders, users } from '../db/schema.js';
import type { Database } from '../db/client.js';
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
import { shopClubView, shopVipClubView, updateShopClub, updateShopVipClub, withNames } from '../services/vip.js';
import { cloneProducts, listCloneSources } from '../services/clone.js';
import { closePreview, closeShop, reopenShop, scheduleClosing } from '../services/closing.js';
import { announceGoalMilestones, updateGoal } from '../services/goal.js';
import { getShopTeam, notifySuperAdmins } from '../services/team.js';
import { restoreSnapshot, takeSnapshot } from '../services/snapshot.js';
import { buyerReachable, getBuyer, listBuyers, messageBuyer } from '../services/buyers.js';
import { audienceIds, checkReach, listBroadcasts, reachStatus, startBroadcast } from '../services/broadcast.js';
import { getDisclaimerAdmin, updateDisclaimer } from '../services/disclaimer.js';
import { deleteLater } from '../services/expiringMessages.js';
import {
  exportProductsCsv,
  importProductsCsv,
  previewProductsCsv,
} from '../services/productsCsv.js';
import { botToken } from '../services/activeBot.js';

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
  env: { BOT_TOKEN?: string | undefined },
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
    const telegram = new TelegramApi(botToken(env));
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

/** Who an organiser is, for what they mark by hand: their name and @username. */
async function organiser(db: Database, id: number): Promise<{ id: number; name: string }> {
  const person = await db.query.users.findFirst({ where: eq(users.telegramId, id) });
  const name = [person?.firstName, person?.username ? `@${person.username}` : null].filter(Boolean).join(' ');
  return { id, name: name || String(id) };
}

export function adminRoutes(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use('*', requireAuth, requireAdmin);

  // An image from the phone (already made smaller), kept here: its link back.
  app.post('/images', async (c) => {
    const mime = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const data = Buffer.from(await c.req.arrayBuffer());
    const id = await saveImage(c.get('db'), c.get('shopId'), c.get('claims').sub, mime, data);
    return c.json({ url: imageUrl(c.get('env'), new URL(c.req.url).origin, id) }, 201);
  });

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
    c.json(getShopAdminView(await reopenShop(c.get('db'), c.get('env'), c.get('shop')))),
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
        sent = await new TelegramApi(botToken(c.get('env'))).sendDocument(
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

  // The GB's buyers, one per person: what each has across their orders, cart and testings.
  app.get('/buyers', async (c) => c.json(await listBuyers(c.get('db'), c.get('env'), c.get('shop'))));
  const buyerParam = z.object({ userId: z.coerce.number().int().positive() });
  app.get('/buyers/:userId', zValidator('param', buyerParam), async (c) =>
    c.json(await getBuyer(c.get('db'), c.get('env'), c.get('shop'), c.req.valid('param').userId)),
  );
  app.post('/buyers/:userId/reach', zValidator('param', buyerParam), async (c) =>
    c.json({ reachable: await buyerReachable(c.get('env'), c.req.valid('param').userId) }),
  );
  app.post(
    '/buyers/:userId/message',
    zValidator('param', buyerParam),
    zValidator('json', z.object({ text: z.string().trim().min(1).max(BROADCAST_MAX_LENGTH) })),
    async (c) => {
      const { userId } = c.req.valid('param');
      // Only to someone who bought or has a cart here.
      await getBuyer(c.get('db'), c.get('env'), c.get('shop'), userId);
      return c.json(await messageBuyer(c.get('db'), c.get('env'), c.get('shop'), userId, c.req.valid('json').text));
    },
  );

  // Messages to the GB's buyers through the bot: how many would get it, send, history.
  app.get(
    '/broadcasts/count',
    zValidator('query', z.object({ audience: broadcastAudience, testingId: z.uuid().optional() })),
    async (c) => {
      const { audience, testingId } = c.req.valid('query');
      return c.json({
        count: (await audienceIds(c.get('db'), c.get('env'), c.get('shop'), audience, testingId ?? null)).length,
      });
    },
  );
  app.get('/broadcasts', async (c) => c.json(await listBroadcasts(c.get('db'), c.get('shopId'))));
  // Who in an audience the bot cannot write to (nothing is sent); the bot tells the result.
  app.post(
    '/broadcasts/reach',
    zValidator('json', z.object({ audience: broadcastAudience, testingId: z.uuid().nullable().optional() })),
    async (c) => {
      const { audience, testingId } = c.req.valid('json');
      return c.json(
        await checkReach(c.get('db'), c.get('env'), c.get('shop'), c.get('claims').sub, audience, {
          testingId: testingId ?? null,
        }),
        202,
      );
    },
  );
  app.get('/broadcasts/reach/:id', zValidator('param', z.object({ id: z.uuid() })), async (c) => {
    const result = await reachStatus(c.get('db'), c.get('shopId'), c.req.valid('param').id);
    if (!result) throw ApiError.notFound('Check not found');
    return c.json(result);
  });
  app.post('/broadcasts', zValidator('json', sendBroadcastRequest), async (c) => {
    const { audience, text, testingId } = c.req.valid('json');
    return c.json(
      await startBroadcast(c.get('db'), c.get('env'), c.get('shop'), c.get('claims').sub, audience, text, {
        testingId,
      }),
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
      await notifyUsers(db, botToken(env), recipients, (lang) =>
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

  // Owner only: a new, hidden GB with the same settings, catalog, labs and testings (no orders).
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

  // Owner only: the bot sends a backup of the GB (settings, catalog, labs, testings; no orders) as JSON.
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
  app.get('/shop/vip-club', async (c) => c.json(await withNames(c.get('db'), shopVipClubView(c.get('shop')))));
  app.put('/shop/vip-club', zValidator('json', updateVipClubRequest), async (c) =>
    c.json(
      await withNames(c.get('db'), await updateShopVipClub(c.get('db'), c.get('env'), c.get('shop'), c.req.valid('json'))),
    ),
  );
  // The shop's guests: they see it when it is "VIP and guests only".
  app.get('/shop/guests', async (c) => c.json(await withNames(c.get('db'), shopClubView(c.get('shop'), 'guest'))));
  app.put('/shop/guests', zValidator('json', updateVipClubRequest), async (c) =>
    c.json(
      await withNames(
        c.get('db'),
        await updateShopClub(c.get('db'), c.get('env'), c.get('shop'), c.req.valid('json'), 'guest'),
      ),
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
  // What checkout asks for (the details themselves arrive encrypted).
  app.put('/shop/checkout-fields', zValidator('json', updateCheckoutFieldsRequest), async (c) =>
    c.json(
      await updateCheckoutFields(c.get('db'), c.get('shopId'), c.req.valid('json')),
    ),
  );
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
  // Product testing on or off (administrators).
  app.put('/shop/testing', requireOwner, zValidator('json', updateTestingEnabledRequest), async (c) =>
    c.json(await setTestingEnabled(c.get('db'), c.get('shopId'), c.req.valid('json').enabled)),
  );
  // The labs the GB works with, and their tests with prices.
  app.get('/labs', async (c) => c.json(await listLabs(c.get('db'), c.get('shopId'))));
  app.post('/labs', zValidator('json', labRequest), async (c) =>
    c.json(await createLab(c.get('db'), c.get('shopId'), c.req.valid('json')), 201),
  );
  app.put('/labs/:id', zValidator('param', idParam), zValidator('json', labRequest), async (c) =>
    c.json(await updateLab(c.get('db'), c.get('shopId'), c.req.valid('param').id, c.req.valid('json'))),
  );
  app.delete('/labs/:id', zValidator('param', idParam), async (c) => {
    await deleteLab(c.get('db'), c.get('shopId'), c.req.valid('param').id);
    return c.json({ ok: true });
  });

  // Every lab report kept in this GB.
  app.get('/testing-reports', async (c) => c.json(await listReports(c.get('db'), { shopIds: [c.get('shopId')] })));
  app.get('/testing-reports/:id/file', zValidator('param', idParam), async (c) =>
    reportFile(await findReport(c.get('db'), c.req.valid('param').id, [c.get('shopId')])),
  );
  app.post('/testing-reports/:id/send', zValidator('param', idParam), async (c) => {
    const sub = c.get('claims').sub;
    if (sub <= 0) throw ApiError.conflict('report_telegram', 'Open the app from Telegram to send the report');
    const row = await findReport(c.get('db'), c.req.valid('param').id, [c.get('shopId')]);
    await sendReportTo(c.get('env'), row, sub, await reportCaption(c.get('db'), row));
    return c.json({ ok: true });
  });
  app.route('/testings', testingAdminRoutes());
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
  // Web access for customers (when the bot is down): a key for someone, taking it back,
  // and adding someone new by their Telegram ID.
  app.get('/web-keys/:userId', zValidator('param', z.object({ userId: z.coerce.number().int() })), async (c) =>
    c.json({ key: await keyOf(c.get('db'), c.get('shopId'), c.req.valid('param').userId) }),
  );
  app.post('/web-keys', zValidator('json', z.object({ userId: z.number().int().positive() })), async (c) => {
    const shop = c.get('shop');
    const given = await giveKey(c.get('db'), shop.id, c.req.valid('json').userId, c.get('claims').sub);
    const base = (c.get('env').PUBLIC_URL ?? new URL(c.req.url).origin).replace(/\/+$/, '');
    return c.json({ ...given, url: `${base}/s/${shop.slug}` }, 201);
  });
  app.delete('/web-keys/:userId', zValidator('param', z.object({ userId: z.coerce.number().int() })), async (c) => {
    await revokeKeys(c.get('db'), c.get('shopId'), c.req.valid('param').userId);
    return c.json({ ok: true });
  });
  app.post(
    '/customers',
    zValidator(
      'json',
      z.object({
        telegramId: z.number().int().positive(),
        username: z.string().trim().max(40).nullable().default(null),
        firstName: z.string().trim().min(1).max(64),
      }),
    ),
    async (c) => {
      await addCustomer(c.get('db'), c.req.valid('json'));
      return c.json({ ok: true }, 201);
    },
  );

  // An order made by the organisers for someone; those waiting for them to open the bot.
  app.post('/orders/create', zValidator('json', adminCreateOrderRequest), async (c) =>
    c.json(await createOrderFor(c.get('db'), c.get('env'), c.get('shop'), c.req.valid('json')), 201),
  );
  app.get('/orders/pending', async (c) => c.json(await listPendingOrders(c.get('db'), c.get('shopId'))));
  app.delete('/orders/pending/:id', zValidator('param', z.object({ id: z.uuid() })), async (c) => {
    await removePendingOrder(c.get('db'), c.get('shopId'), c.req.valid('param').id);
    return c.json({ ok: true });
  });

  // Shipping labels: asking one customer, or every paid order without one (or counting them).
  app.post('/orders/label-requests', zValidator('json', labelRequests), async (c) =>
    c.json(await requestLabels(c.get('db'), c.get('env'), c.get('shop'), c.req.valid('json'))),
  );
  app.post(
    '/orders/:id/label-request',
    zValidator('param', z.object({ id: z.uuid() })),
    zValidator('json', labelRequest),
    async (c) =>
      c.json(
        await requestLabel(c.get('db'), c.get('env'), c.get('shop'), c.req.valid('param').id, c.req.valid('json').note),
      ),
  );
  app.get('/orders/:id/label', zValidator('param', z.object({ id: z.uuid() })), async (c) => {
    const file = await labelFile(c.get('db'), c.get('shopId'), c.req.valid('param').id);
    return new Response(new Uint8Array(file.data), {
      headers: {
        'Content-Type': file.mime,
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
  app.post('/orders/:id/label/send', zValidator('param', z.object({ id: z.uuid() })), async (c) => {
    await sendLabelTo(c.get('db'), c.get('env'), c.get('shop'), c.req.valid('param').id, c.get('claims').sub);
    return c.json({ ok: true });
  });

  app.get('/orders', async (c) =>
    c.json(
      await markTestings(c.get('db'), c.get('shopId'), await markBlocked(c, await listAllOrders(c.get('db'), c.get('shopId')))),
    ),
  );
  app.get('/orders/:id', zValidator('param', idParam), async (c) => {
    const order = await getOrder(c.get('db'), c.get('shopId'), c.req.valid('param').id);
    if (!order) throw ApiError.notFound('Order not found');
    const [marked] = await markBlocked(c, [order]);
    const extraUnpaid = await unpaidExtras(c.get('db'), order.id);
    return c.json({ ...(marked ?? order), ...(extraUnpaid.length > 0 ? { extraUnpaid } : {}) });
  });

  // Blacklist of the GB (administrators): for those in it the GB does not exist.
  app.get('/blacklist', requireOwner, async (c) =>
    c.json(await shopBlacklistView(c.get('db'), c.get('shop'))),
  );
  app.post('/blacklist/check', requireOwner, zValidator('json', blacklistWho), async (c) =>
    c.json(await checkBlacklist(c.get('db'), c.req.valid('json').who, c.get('shopId'))),
  );
  app.post('/blacklist', requireOwner, zValidator('json', addToBlacklistRequest), async (c) => {
    return c.json(
      await addToShopBlacklist(c.get('db'), c.get('env'), c.get('shop'), c.get('claims').sub, c.req.valid('json')),
    );
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
      const { order, previous } = await changeOrderStatus(c.get('db'), shop.id, c.req.valid('param').id, {
        ...c.req.valid('json'),
        by: await organiser(c.get('db'), c.get('claims').sub),
      });
      // The customer hears about it from the bot (best effort).
      if (order.status !== previous) {
        await notifyUsers(c.get('db'), botToken(c.get('env')), await customerChat(c, order), (lang) =>
          buildStatusMessage(lang, shop.name, order, previous),
        );
        // A confirmed payment may pass a milestone of the GB's minimum.
        if (order.status === 'paid') {
          await announceGoalMilestones(c.get('db'), c.get('env'), shop.id);
          await announceTestingTiers(c.get('db'), c.get('env'), shop.id);
        }
      }
      return c.json(order);
    },
  );

  // Correcting the carrier or tracking of a shipped order (the customer is told).
  app.patch(
    '/orders/:id/shipment',
    zValidator('param', idParam),
    zValidator('json', updateShipmentRequest),
    async (c) => {
      const shop = c.get('shop');
      const id = c.req.valid('param').id;
      const order = await updateShipment(c.get('db'), shop.id, id, c.req.valid('json'));
      if (!order) return c.json(await getOrder(c.get('db'), shop.id, id));
      await notifyUsers(c.get('db'), botToken(c.get('env')), await customerChat(c, order), (lang) =>
        [
          tr(lang, 'status.shipmentUpdated', { ref: tr(lang, 'order.ref', { shop: shop.name, id: order.id.slice(0, 8) }) }),
          shipmentLine(lang, order),
        ].join('\n'),
      );
      return c.json(order);
    },
  );

  // What taking products out would leave (total, refund, testings dropped), without doing it.
  app.post(
    '/orders/:id/reduce-preview',
    zValidator('param', idParam),
    zValidator('json', reducePreviewRequest),
    async (c) =>
      c.json(await previewReduceOrder(c.get('db'), c.get('shopId'), c.req.valid('param').id, c.req.valid('json').lines)),
  );

  // The organiser takes products out (sold out…): applied at once, the customer is told why.
  app.post(
    '/orders/:id/reduce',
    zValidator('param', idParam),
    zValidator('json', reduceOrderRequest),
    async (c) => {
      const shop = c.get('shop');
      const { lines, reason } = c.req.valid('json');
      const { order, removed } = await reduceOrder(c.get('db'), shop.id, c.req.valid('param').id, lines, reason);
      const money = (amount: number): string => formatMoney(amount, order.currency);
      await notifyUsers(c.get('db'), botToken(c.get('env')), await customerChat(c, order), (lang) =>
        [
          tr(lang, 'order.reduced', { ref: tr(lang, 'order.ref', { shop: shop.name, id: order.id.slice(0, 8) }) }),
          ...removed.map((r) => `• −${r.quantity} × ${r.name}`),
          tr(lang, 'order.reducedReason', { reason }),
          // Paid more than it now costs: refund. Still something to pay: how much. Otherwise the new total.
          order.amountDue < 0
            ? tr(lang, 'order.reducedRefund', { amount: money(-order.amountDue) })
            : order.amountDue > 0
              ? tr(lang, 'order.reducedToPay', { total: money(order.amountDue) })
              : tr(lang, 'order.reducedTotal', { total: money(order.total) }),
        ].join('\n'),
      );
      return c.json(order);
    },
  );
  app.get('/carriers', async (c) => c.json(await recentCarriers(c.get('db'), c.get('shopId'))));

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
      testings: shop.testingEnabled ? await listTestings(db, shop.id) : [],
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
    await notifyUsers(c.get('db'), botToken(c.get('env')), await customerChat(c, order), (lang) =>
      buildChangeDecisionMessage(lang, order, true),
    );
    return c.json(order);
  });
  app.post('/orders/:id/change/reject', zValidator('param', idParam), async (c) => {
    const order = await clearOrderChange(c.get('db'), c.get('shopId'), c.req.valid('param').id);
    await notifyUsers(c.get('db'), botToken(c.get('env')), await customerChat(c, order), (lang) =>
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

  // Everything owed back to customers, order by order, with why.
  app.get('/refunds', async (c) => c.json(await pendingRefunds(c.get('db'), c.get('shopId'))));

  // The admin sent the overpaid difference back to the customer.
  app.post('/orders/:id/refund', zValidator('param', idParam), async (c) =>
    c.json(
      await recordRefund(c.get('db'), c.get('shopId'), c.req.valid('param').id, await organiser(c.get('db'), c.get('claims').sub)),
    ),
  );

  app.delete('/orders/:id', zValidator('param', idParam), async (c) => {
    await deleteOrder(c.get('db'), c.get('shopId'), c.req.valid('param').id);
    return c.body(null, 204);
  });

  return app;
}
