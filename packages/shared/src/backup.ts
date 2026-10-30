import { z } from 'zod';
import { currencyCode, isoDateTime, moneyAmount, slug } from './common.js';
import { productOption } from './catalog.js';
import { priceTier } from './pricing.js';
import { paymentSetup } from './payments.js';
import { shippingZone } from './shop.js';
import { vipClub } from './vip.js';

/**
 * Everything that makes up a GB except its orders, customers and admins: its
 * settings and its catalog. Used to duplicate a GB and as the JSON backup
 * file (export / import).
 */
export const gbSnapshot = z.object({
  format: z.literal('tma-gb'),
  version: z.literal(1),
  exportedAt: isoDateTime,
  shop: z.object({
    name: z.string().trim().min(1).max(128),
    slug,
    description: z.string().max(1024),
    nameEn: z.string().max(128).nullable(),
    descriptionEn: z.string().max(1024).nullable(),
    imageUrl: z.url().nullable(),
    vipOnly: z.boolean(),
    currency: currencyCode,
    orderFee: moneyAmount,
    orderFeeLabel: z.string().min(1).max(64),
    vipNoFee: z.boolean(),
    vipNoShipping: z.boolean().default(false),
    autoCancelHours: z.number().int().min(0).max(720),
    closingWarnHours: z.number().int().min(0).max(720),
    shippingZones: z.array(shippingZone).max(50),
    paymentSetup: paymentSetup.nullable(),
    addressPublicKey: z.string().max(4000).nullable(),
    vipClub,
    useGlobalVipClub: z.boolean(),
    allowGuests: z.boolean().default(false),
    guestList: vipClub.default({ groups: [], userIds: [], usernames: [] }),
    useGlobalGuests: z.boolean().default(true),
    /** Text to accept before entering, or null. */
    disclaimer: z.string().max(4000).nullable(),
    goalAmount: z.number().int().positive().nullable().default(null),
    goalShowAmount: z.boolean().default(true),
  }),
  categories: z
    .array(
      z.object({
        slug,
        title: z.string().min(1).max(128),
        sortOrder: z.number().int(),
      }),
    )
    .max(500),
  products: z
    .array(
      z.object({
        slug,
        /** Link name of its category, or null. */
        category: slug.nullable(),
        title: z.string().min(1).max(256),
        description: z.string().max(4096),
        titleEn: z.string().max(256).nullable(),
        descriptionEn: z.string().max(4096).nullable(),
        price: moneyAmount,
        vipPrice: moneyAmount.nullable(),
        currency: currencyCode,
        imageUrl: z.url().nullable(),
        stock: z.number().int().nonnegative().nullable(),
        isActive: z.boolean(),
        vipOnly: z.boolean().default(false),
        minQuantity: z.number().int().min(1).max(999).default(1),
        options: z.array(productOption).max(3),
        priceTiers: z.array(priceTier).max(10),
        variants: z
          .array(
            z.object({
              values: z.array(z.string().min(1).max(32)).min(1).max(3),
              price: moneyAmount.nullable(),
              vipPrice: moneyAmount.nullable(),
              stock: z.number().int().nonnegative().nullable(),
              isActive: z.boolean(),
            }),
          )
          .max(200),
      }),
    )
    .max(5000),
});
export type GbSnapshot = z.infer<typeof gbSnapshot>;

/** Duplicate a GB: the copy's name and link name. */
export const duplicateShopRequest = z.object({
  name: z.string().trim().min(1).max(128),
  slug,
});
export type DuplicateShopRequest = z.infer<typeof duplicateShopRequest>;

/** What a backup file holds, to show before importing it. */
export const gbBackupPreview = z.object({
  name: z.string(),
  slug: z.string(),
  exportedAt: z.string(),
  products: z.number().int().nonnegative(),
  variants: z.number().int().nonnegative(),
  categories: z.number().int().nonnegative(),
  shippingZones: z.number().int().nonnegative(),
  /** Where payments would go: shown so the importer checks them before saving. */
  evmAddress: z.string().nullable(),
  solanaAddress: z.string().nullable(),
  manualMethods: z.array(z.object({ name: z.string(), instructions: z.string() })),
  hasAddressKey: z.boolean(),
  /** Link name already used by another GB. */
  slugTaken: z.boolean(),
});
export type GbBackupPreview = z.infer<typeof gbBackupPreview>;

/**
 * Import a backup as a new GB. The receiving addresses are sent back as the
 * importer saw and confirmed them; they must match the file.
 */
export const importGbRequest = z.object({
  backup: gbSnapshot,
  name: z.string().trim().min(1).max(128),
  slug,
  confirmedEvmAddress: z.string().nullable(),
  confirmedSolanaAddress: z.string().nullable(),
});
export type ImportGbRequest = z.infer<typeof importGbRequest>;

export const previewGbRequest = z.object({ backup: gbSnapshot });
