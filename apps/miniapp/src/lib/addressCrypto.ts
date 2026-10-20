import type { DeliveryAddress } from '@tma-shop/shared';

/**
 * Delivery addresses are encrypted on the customer's device and only the shop
 * admin, holding the private key, can read them:
 *
 *  - a random AES-256-GCM key encrypts the address (JSON);
 *  - the shop's RSA-OAEP-2048 (SHA-256) public key wraps that AES key;
 *  - the envelope `{ v, kid, key, iv, data }` is what the server stores.
 *
 * The admin's private key lives only on the admin's device (localStorage).
 */

export interface AddressEnvelope {
  v: 1;
  /** Fingerprint of the public key used. */
  kid: string;
  /** RSA-OAEP-wrapped AES key, base64. */
  key: string;
  /** AES-GCM IV, base64. */
  iv: string;
  /** AES-GCM ciphertext of the address JSON, base64. */
  data: string;
}

const RSA = { name: 'RSA-OAEP', hash: 'SHA-256' } as const;

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text: string): ArrayBuffer {
  const binary = atob(text.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function pemBody(pem: string, label: string): string {
  return pem.replace(new RegExp(`-----(BEGIN|END) ${label}-----`, 'g'), '').replace(/\s+/g, '');
}

function toPem(base64: string, label: string): string {
  const lines = base64.match(/.{1,64}/g) ?? [];
  return [`-----BEGIN ${label}-----`, ...lines, `-----END ${label}-----`].join('\n');
}

/** Same fingerprint as the API: first 16 hex chars of SHA-256 over the SPKI bytes. */
export async function keyFingerprint(spki: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', spki));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

export function cryptoAvailable(): boolean {
  return typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined';
}

/** New key pair, generated on this device. The private key is returned as PEM. */
export async function generateAddressKeys(): Promise<{
  publicKey: string;
  privateKeyPem: string;
  fingerprint: string;
}> {
  const pair = await crypto.subtle.generateKey(
    { ...RSA, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ['encrypt', 'decrypt'],
  );
  const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  return {
    publicKey: toBase64(spki),
    privateKeyPem: toPem(toBase64(pkcs8), 'PRIVATE KEY'),
    fingerprint: await keyFingerprint(spki),
  };
}

/** Encrypts an address for the shop whose public key (base64 SPKI) is given. */
export async function encryptAddress(
  address: DeliveryAddress,
  publicKey: string,
  kid: string,
): Promise<string> {
  const rsaKey = await crypto.subtle.importKey('spki', fromBase64(publicKey), RSA, false, [
    'encrypt',
  ]);
  const aesKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    new TextEncoder().encode(JSON.stringify(address)),
  );
  const rawKey = await crypto.subtle.exportKey('raw', aesKey);
  const wrapped = await crypto.subtle.encrypt(RSA, rsaKey, rawKey);
  const envelope: AddressEnvelope = {
    v: 1,
    kid,
    key: toBase64(wrapped),
    iv: toBase64(iv.buffer),
    data: toBase64(data),
  };
  return JSON.stringify(envelope);
}

async function importPrivateKey(privateKeyPem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'pkcs8',
    fromBase64(pemBody(privateKeyPem, 'PRIVATE KEY')),
    RSA,
    true,
    ['decrypt'],
  );
}

/** Reads an address envelope with the admin's private key. */
export async function decryptAddress(
  envelopeJson: string,
  privateKeyPem: string,
): Promise<DeliveryAddress> {
  const envelope = JSON.parse(envelopeJson) as AddressEnvelope;
  const rsaKey = await importPrivateKey(privateKeyPem);
  const rawKey = await crypto.subtle.decrypt(RSA, rsaKey, fromBase64(envelope.key));
  const aesKey = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(envelope.iv) },
    aesKey,
    fromBase64(envelope.data),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as DeliveryAddress;
}

/** Whether a private key (PEM) belongs to the given public key (base64 SPKI). */
export async function privateKeyMatches(privateKeyPem: string, publicKey: string): Promise<boolean> {
  try {
    const priv = await crypto.subtle.exportKey('jwk', await importPrivateKey(privateKeyPem));
    const pub = await crypto.subtle.exportKey(
      'jwk',
      await crypto.subtle.importKey('spki', fromBase64(publicKey), RSA, true, ['encrypt']),
    );
    return priv.n !== undefined && priv.n === pub.n && priv.e === pub.e;
  } catch {
    return false;
  }
}

// --- Storage on this device (wrapped: storage can be unavailable) -----------

const PRIVATE_KEY_PREFIX = 'tma-shop:address-private-key:';
const SAVED_ADDRESS_KEY = 'tma-shop:delivery-address';

function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string | null): boolean {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** The admin's private key for a shop, kept only on this device. */
export function loadPrivateKey(shopId: string): string | null {
  return storageGet(PRIVATE_KEY_PREFIX + shopId);
}

export function savePrivateKey(shopId: string, privateKeyPem: string | null): boolean {
  return storageSet(PRIVATE_KEY_PREFIX + shopId, privateKeyPem);
}

/** The customer's last address, remembered on their own device to prefill checkout. */
export function loadSavedAddress(): DeliveryAddress | null {
  const raw = storageGet(SAVED_ADDRESS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DeliveryAddress;
  } catch {
    return null;
  }
}

export function saveAddress(address: DeliveryAddress | null): void {
  storageSet(SAVED_ADDRESS_KEY, address ? JSON.stringify(address) : null);
}
