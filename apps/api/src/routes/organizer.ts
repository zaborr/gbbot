import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import {
  importGbRequest,
  organizerShopInput,
  previewGbRequest,
  type GbBackupPreview,
  type GbSnapshot,
} from '@tma-shop/shared';
import type { AppBindings } from '../context.js';
import { requireAuth } from '../auth/middleware.js';
import { ApiError } from '../lib/errors.js';
import { shops } from '../db/schema.js';
import { toShopAdminDTO } from '../db/mappers.js';
import { isSuperAdmin, createOrganizerShop } from '../services/shop.js';
import { isOrganizer, notifySuperAdmins } from '../services/team.js';
import { restoreSnapshot } from '../services/snapshot.js';

/** Organisers (and super-admins): create a GB of their own, from scratch or from a backup. */
export function organizerRoutes(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use('*', requireAuth);
  app.use('*', async (c, next) => {
    const { sub } = c.get('claims');
    if (!isSuperAdmin(c.get('env'), sub) && !(await isOrganizer(c.get('db'), sub))) {
      throw ApiError.forbidden('Organiser role required');
    }
    await next();
  });

  app.post('/shops', zValidator('json', organizerShopInput), async (c) => {
    const db = c.get('db');
    const { sub } = c.get('claims');
    const shop = await createOrganizerShop(db, sub, c.req.valid('json'));
    await notifySuperAdmins(db, c.get('env'), sub, 'platform.gbCreated', {
      shop: shop.name,
      slug: shop.slug,
    });
    return c.json(shop, 201);
  });

  // A backup file (JSON): first see what it holds, then import it as a new GB.
  app.post('/shops/import/preview', zValidator('json', previewGbRequest), async (c) => {
    const { backup } = c.req.valid('json');
    const taken = await c
      .get('db')
      .query.shops.findFirst({ where: eq(shops.slug, backup.shop.slug), columns: { id: true } });
    return c.json(backupPreview(backup, taken !== undefined));
  });

  app.post('/shops/import', zValidator('json', importGbRequest), async (c) => {
    const db = c.get('db');
    const { sub } = c.get('claims');
    const input = c.req.valid('json');
    const setup = input.backup.shop.paymentSetup;
    // Where the money goes must be what the importer saw and confirmed.
    if (
      (setup?.evmAddress ?? null) !== input.confirmedEvmAddress ||
      (setup?.solanaAddress ?? null) !== input.confirmedSolanaAddress
    ) {
      throw ApiError.badRequest(
        'wallets_not_confirmed',
        'Confirm the receiving addresses of the backup before importing it',
      );
    }
    const shop = await restoreSnapshot(db, input.backup, {
      name: input.name,
      slug: input.slug,
      ownerId: sub,
    });
    await notifySuperAdmins(db, c.get('env'), sub, 'platform.gbCreated', {
      shop: shop.name,
      slug: shop.slug,
    });
    return c.json(toShopAdminDTO(shop), 201);
  });

  return app;
}

export function backupPreview(backup: GbSnapshot, slugTaken: boolean): GbBackupPreview {
  const setup = backup.shop.paymentSetup;
  return {
    name: backup.shop.name,
    slug: backup.shop.slug,
    exportedAt: backup.exportedAt,
    products: backup.products.length,
    variants: backup.products.reduce((n, p) => n + p.variants.length, 0),
    categories: backup.categories.length,
    shippingZones: backup.shop.shippingZones.length,
    evmAddress: setup?.evmAddress ?? null,
    solanaAddress: setup?.solanaAddress ?? null,
    manualMethods: (setup?.manual ?? []).map((m) => ({ name: m.name, instructions: m.instructions })),
    hasAddressKey: backup.shop.addressPublicKey !== null,
    slugTaken,
  };
}
