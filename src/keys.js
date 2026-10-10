// Solana keypairs with nothing but node:crypto.
// A Solana address is the base58 of the raw 32-byte ed25519 public key.
// A Solana CLI keypair file is a JSON array of 64 bytes: seed (32) || public key (32).

import { generateKeyPairSync, createPrivateKey, createPublicKey } from 'node:crypto';
import { encode } from './base58.js';

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function randomKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(16);
  return { seed, publicKey: pub };
}

export function keypairFromSeed(seed) {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
  const pub = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(12);
  return { seed: Buffer.from(seed), publicKey: pub, privateKey };
}

export const address = (publicKey) => encode(publicKey);

export function toSolanaKeypairJson(seed, publicKey) {
  return JSON.stringify([...seed, ...publicKey]);
}
