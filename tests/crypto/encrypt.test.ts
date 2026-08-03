import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, generateKey } from '../../src/crypto/encrypt.js';

describe('Encryption', () => {
  const testKey = generateKey();
  const plaintext = 'secret_access_token_12345';

  it('should generate a 64-character hex key', () => {
    const key = generateKey();
    expect(key).toHaveLength(64);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should encrypt and decrypt successfully', () => {
    const encrypted = encrypt(plaintext, testKey);
    const decrypted = decrypt(encrypted, testKey);
    
    expect(encrypted).not.toBe(plaintext);
    expect(encrypted).toContain(':');
    expect(decrypted).toBe(plaintext);
  });

  it('should produce different ciphertexts for same plaintext', () => {
    const encrypted1 = encrypt(plaintext, testKey);
    const encrypted2 = encrypt(plaintext, testKey);
    
    expect(encrypted1).not.toBe(encrypted2); // Different IVs
  });

  it('should throw on invalid key length', () => {
    expect(() => encrypt(plaintext, 'short')).toThrow();
    expect(() => decrypt('iv:tag:cipher', 'short')).toThrow();
  });

  it('should throw on invalid encrypted format', () => {
    expect(() => decrypt('invalid', testKey)).toThrow();
  });
});
