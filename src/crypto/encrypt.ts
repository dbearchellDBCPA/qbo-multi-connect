import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const KEY_LENGTH = 32; // 256 bits

/**
 * Encrypt plaintext using AES-256-GCM
 * @param plaintext - String to encrypt
 * @param key - 64-character hex string (32 bytes)
 * @returns Encrypted string in format: iv:authTag:ciphertext (all base64)
 */
export function encrypt(plaintext: string, key: string): string {
  if (!plaintext) {
    throw new Error('Plaintext cannot be empty');
  }
  
  if (!key || key.length !== KEY_LENGTH * 2) {
    throw new Error(`Encryption key must be ${KEY_LENGTH * 2} hex characters (${KEY_LENGTH} bytes)`);
  }

  const keyBuffer = Buffer.from(key, 'hex');
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, keyBuffer, iv);

  let ciphertext = cipher.update(plaintext, 'utf8', 'base64');
  ciphertext += cipher.final('base64');

  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:ciphertext
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext}`;
}

/**
 * Decrypt ciphertext using AES-256-GCM
 * @param encrypted - Encrypted string in format: iv:authTag:ciphertext (all base64)
 * @param key - 64-character hex string (32 bytes)
 * @returns Decrypted plaintext
 */
export function decrypt(encrypted: string, key: string): string {
  if (!encrypted) {
    throw new Error('Encrypted text cannot be empty');
  }

  if (!key || key.length !== KEY_LENGTH * 2) {
    throw new Error(`Encryption key must be ${KEY_LENGTH * 2} hex characters (${KEY_LENGTH} bytes)`);
  }

  const parts = encrypted.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted format. Expected iv:authTag:ciphertext');
  }

  const [ivBase64, authTagBase64, ciphertext] = parts;
  const keyBuffer = Buffer.from(key, 'hex');
  const iv = Buffer.from(ivBase64, 'base64');
  const authTag = Buffer.from(authTagBase64, 'base64');

  const decipher = createDecipheriv(ALGORITHM, keyBuffer, iv);
  decipher.setAuthTag(authTag);

  let plaintext = decipher.update(ciphertext, 'base64', 'utf8');
  plaintext += decipher.final('utf8');

  return plaintext;
}

/**
 * Generate a secure random encryption key
 * @returns 64-character hex string (32 bytes)
 */
export function generateKey(): string {
  return randomBytes(KEY_LENGTH).toString('hex');
}
