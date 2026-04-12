import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import { Jimp, JimpMime } from "jimp";

import { FileAvatarCache } from "../src/avatar-cache.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("FileAvatarCache", () => {
  it("writes cached avatars as fixed-size png files", async () => {
    const tempDir = createTempDir("octopulse-avatar-cache-");
    const sourceImage = new Jimp({ width: 80, height: 40, color: 0xff0000ff });
    const sourceBytes = await sourceImage.getBuffer(JimpMime.png);
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(sourceBytes)));
    const cache = new FileAvatarCache({
      cacheDirPath: tempDir,
      fetchImpl,
    });

    const avatarUri = await cache.resolveAvatarFileUri({
      key: "alice",
      avatarUrl: "https://avatars.example.test/alice.png",
    });

    expect(avatarUri).toBeTruthy();
    expect(avatarUri).toContain(".png");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const cachedImage = await Jimp.read(fileURLToPath(avatarUri!));

    expect(cachedImage.width).toBe(18);
    expect(cachedImage.height).toBe(18);

    const secondAvatarUri = await cache.resolveAvatarFileUri({
      key: "alice",
      avatarUrl: "https://avatars.example.test/alice.png",
    });

    expect(secondAvatarUri).toBe(avatarUri);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

function createTempDir(prefix: string): string {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}
