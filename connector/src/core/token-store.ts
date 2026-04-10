/**
 * Cross-platform UAT (User Access Token) encrypted storage.
 * - Linux: AES-256-GCM encrypted files in ~/.local/share/openclaw-feishu-uat/
 * - macOS: Keychain via `security` CLI (optional, falls back to encrypted file)
 * - Windows: AES-256-GCM encrypted files in %LOCALAPPDATA%\openclaw-feishu-uat\
 *
 * Key derivation: UAT_MASTER_KEY env var -> SHA-256 -> 32-byte key
 * Storage format: base64(iv || authTag || ciphertext)
 */
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const STORE_DIR =
  process.env.UAT_STORE_DIR ||
  (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || '', 'openclaw-feishu-uat')
    : path.join(process.env.HOME || '', '.local', 'share', 'openclaw-feishu-uat'));

const ALGORITHM = 'aes-256-gcm';

function getMasterKey(): Buffer {
  const secret = process.env.UAT_MASTER_KEY;
  if (!secret) {
    throw new Error('UAT_MASTER_KEY environment variable is required for token encryption');
  }
  return crypto.createHash('sha256').update(secret).digest();
}

export async function initTokenStore(): Promise<void> {
  await fs.mkdir(STORE_DIR, { recursive: true });
}

function tokenPath(openId: string): string {
  const safe = openId.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(STORE_DIR, `${safe}.uat`);
}

export async function storeUserToken(openId: string, token: string): Promise<void> {
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const filePath = tokenPath(openId);
  const data = Buffer.concat([iv, authTag, encrypted]).toString('base64');
  await fs.writeFile(filePath, data, { mode: 0o600 });
}

export async function getUserToken(openId: string): Promise<string | null> {
  const filePath = tokenPath(openId);
  try {
    const data = await fs.readFile(filePath, 'utf8');
    const buf = Buffer.from(data, 'base64');
    if (buf.length < 28) return null; // iv(12) + tag(16) minimum

    const iv = buf.subarray(0, 12);
    const authTag = buf.subarray(12, 28);
    const encrypted = buf.subarray(28);

    const key = getMasterKey();
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(encrypted).toString('utf8') + decipher.final('utf8');
  } catch {
    return null;
  }
}

export async function deleteUserToken(openId: string): Promise<void> {
  const filePath = tokenPath(openId);
  await fs.unlink(filePath).catch(() => {});
}
