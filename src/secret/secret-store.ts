import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../config';

/**
 * 密钥存储：AES-256-GCM，本地 key 文件（0600）。
 * 密文格式：enc:v1:<base64(iv12 | tag16 | ciphertext)>
 */
export class SecretStore {
  private key: Buffer;

  constructor(keyFile: string) {
    ensureDir(path.dirname(keyFile));
    if (fs.existsSync(keyFile)) {
      this.key = fs.readFileSync(keyFile);
    } else {
      this.key = crypto.randomBytes(32);
      fs.writeFileSync(keyFile, this.key, { mode: 0o600 });
    }
  }

  isEncrypted(s: string | undefined): boolean {
    return typeof s === 'string' && s.startsWith('enc:v1:');
  }

  encrypt(plain: string): string {
    if (!plain) return '';
    if (this.isEncrypted(plain)) return plain;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `enc:v1:${Buffer.concat([iv, tag, enc]).toString('base64')}`;
  }

  decrypt(value: string): string {
    if (!this.isEncrypted(value)) return value;
    try {
      const buf = Buffer.from(value.slice('enc:v1:'.length), 'base64');
      const iv = buf.subarray(0, 12);
      const tag = buf.subarray(12, 28);
      const data = buf.subarray(28);
      const d = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(data), d.final()]).toString('utf8');
    } catch {
      return '';
    }
  }
}
