import { createHash } from "node:crypto";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Jimp, JimpMime } from "jimp";

import { resolveAppPaths } from "./config.js";

const DEFAULT_AVATAR_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_AVATAR_SIZE = 18;

export interface AvatarImageCache {
  resolveAvatarFileUri(input: { key: string; avatarUrl: string }): Promise<string | null>;
}

export interface FileAvatarCacheOptions {
  cacheDirPath?: string;
  fetchImpl?: typeof fetch;
  maxAgeMs?: number;
}

export class FileAvatarCache implements AvatarImageCache {
  private readonly cacheDirPath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxAgeMs: number;

  constructor(options: FileAvatarCacheOptions = {}) {
    this.cacheDirPath = options.cacheDirPath ?? path.join(resolveAppPaths().stateDirPath, "avatars");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_AVATAR_CACHE_MAX_AGE_MS;
  }

  async resolveAvatarFileUri(input: { key: string; avatarUrl: string }): Promise<string | null> {
    const cachePath = path.join(this.cacheDirPath, createAvatarCacheKey(input.key));

    await mkdir(this.cacheDirPath, { recursive: true });

    if (await isFresh(cachePath, this.maxAgeMs)) {
      return pathToFileURL(cachePath).toString();
    }

    try {
      const response = await this.fetchImpl(buildSizedAvatarUrl(input.avatarUrl));

      if (!response.ok) {
        throw new Error(`Avatar download failed with status ${response.status}`);
      }

      const bytes = await resizeAvatarToPng(Buffer.from(await response.arrayBuffer()));
      const tempPath = `${cachePath}.tmp-${process.pid}-${Date.now()}`;

      await writeFile(tempPath, bytes);
      await rename(tempPath, cachePath);
      return pathToFileURL(cachePath).toString();
    } catch {
      if (await fileExists(cachePath)) {
        return pathToFileURL(cachePath).toString();
      }

      return null;
    }
  }
}

function createAvatarCacheKey(key: string): string {
  return `${createHash("sha1").update(key).digest("hex")}.png`;
}

async function isFresh(filePath: string, maxAgeMs: number): Promise<boolean> {
  try {
    const metadata = await stat(filePath);
    return Date.now() - metadata.mtimeMs < maxAgeMs;
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function buildSizedAvatarUrl(avatarUrl: string): string {
  try {
    const url = new URL(avatarUrl);
    url.searchParams.set("s", String(DEFAULT_AVATAR_SIZE));
    return url.toString();
  } catch {
    return avatarUrl;
  }
}

async function resizeAvatarToPng(bytes: Buffer): Promise<Buffer> {
  const image = await Jimp.read(bytes);

  image.cover({ w: DEFAULT_AVATAR_SIZE, h: DEFAULT_AVATAR_SIZE });

  return image.getBuffer(JimpMime.png);
}
