import * as fs from "fs/promises";
import * as path from "path";
import { randomUUID } from "crypto";
import mime from "mime-types";
import type { ImageGenProfile, ImageGenReferencePhoto } from "../../shared/types";
import { getUserDataDir } from "../utils/user-data-dir";

type StoredProfiles = {
  profiles: ImageGenProfile[];
};

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

export class ImageGenProfileService {
  private getRootDir(): string {
    return path.join(getUserDataDir(), "agents", "image-profiles");
  }

  private getManifestPath(): string {
    return path.join(this.getRootDir(), "profiles.json");
  }

  private async ensureRoot(): Promise<void> {
    await fs.mkdir(this.getRootDir(), { recursive: true });
  }

  private async readStore(): Promise<StoredProfiles> {
    await this.ensureRoot();
    try {
      const raw = await fs.readFile(this.getManifestPath(), "utf-8");
      const parsed = JSON.parse(raw) as StoredProfiles;
      return {
        profiles: Array.isArray(parsed?.profiles) ? parsed.profiles : [],
      };
    } catch {
      return { profiles: [] };
    }
  }

  private async writeStore(store: StoredProfiles): Promise<void> {
    await this.ensureRoot();
    await fs.writeFile(this.getManifestPath(), JSON.stringify(store, null, 2), "utf-8");
  }

  private async importReferencePhotos(
    profileId: string,
    filePaths: string[],
  ): Promise<ImageGenReferencePhoto[]> {
    const profileDir = path.join(this.getRootDir(), profileId);
    await fs.mkdir(profileDir, { recursive: true });
    const photos: ImageGenReferencePhoto[] = [];
    for (const originalPath of filePaths) {
      const resolved = path.resolve(originalPath);
      const stats = await fs.stat(resolved);
      if (!stats.isFile()) continue;
      const ext = path.extname(resolved) || ".img";
      const fileName = sanitizeFileName(path.basename(resolved, ext));
      const id = randomUUID();
      const nextPath = path.join(profileDir, `${fileName}-${id}${ext}`);
      await fs.copyFile(resolved, nextPath);
      photos.push({
        id,
        path: nextPath,
        name: path.basename(resolved),
        mimeType: (mime.lookup(resolved) || undefined) as string | undefined,
        size: stats.size,
      });
    }
    return photos;
  }

  async list(): Promise<ImageGenProfile[]> {
    const store = await this.readStore();
    return store.profiles.sort((left, right) => {
      if (left.isDefault && !right.isDefault) return -1;
      if (right.isDefault && !left.isDefault) return 1;
      return right.updatedAt - left.updatedAt;
    });
  }

  async create(input: {
    name: string;
    description?: string;
    isDefault?: boolean;
    referencePhotoPaths?: string[];
  }): Promise<ImageGenProfile> {
    const store = await this.readStore();
    const now = Date.now();
    const profile: ImageGenProfile = {
      id: randomUUID(),
      name: input.name.trim(),
      description: input.description?.trim() || undefined,
      isDefault: !!input.isDefault,
      referencePhotos: [],
      createdAt: now,
      updatedAt: now,
    };
    profile.referencePhotos = await this.importReferencePhotos(
      profile.id,
      input.referencePhotoPaths || [],
    );
    if (profile.isDefault) {
      for (const existing of store.profiles) existing.isDefault = false;
    }
    store.profiles.unshift(profile);
    await this.writeStore(store);
    return profile;
  }

  async update(
    id: string,
    patch: {
      name?: string;
      description?: string;
      isDefault?: boolean;
      addReferencePhotoPaths?: string[];
      removeReferencePhotoIds?: string[];
    },
  ): Promise<ImageGenProfile | null> {
    const store = await this.readStore();
    const profile = store.profiles.find((entry) => entry.id === id);
    if (!profile) return null;
    if (patch.name !== undefined) profile.name = patch.name.trim();
    if (patch.description !== undefined) {
      profile.description = patch.description.trim() || undefined;
    }
    if (patch.isDefault !== undefined) {
      if (patch.isDefault) {
        for (const existing of store.profiles) existing.isDefault = false;
      }
      profile.isDefault = patch.isDefault;
    }
    if (patch.removeReferencePhotoIds?.length) {
      const toRemove = new Set(patch.removeReferencePhotoIds);
      const removed = profile.referencePhotos.filter((photo) => toRemove.has(photo.id));
      profile.referencePhotos = profile.referencePhotos.filter((photo) => !toRemove.has(photo.id));
      await Promise.all(
        removed.map(async (photo) => {
          try {
            await fs.unlink(photo.path);
          } catch {
            // Ignore stale file cleanup failures.
          }
        }),
      );
    }
    if (patch.addReferencePhotoPaths?.length) {
      const imported = await this.importReferencePhotos(id, patch.addReferencePhotoPaths);
      profile.referencePhotos.push(...imported);
    }
    profile.updatedAt = Date.now();
    await this.writeStore(store);
    return profile;
  }

  async delete(id: string): Promise<boolean> {
    const store = await this.readStore();
    const index = store.profiles.findIndex((entry) => entry.id === id);
    if (index === -1) return false;
    const [removed] = store.profiles.splice(index, 1);
    if (removed) {
      try {
        await fs.rm(path.join(this.getRootDir(), removed.id), { recursive: true, force: true });
      } catch {
        // Ignore stale profile directory cleanup failures.
      }
    }
    if (!store.profiles.some((entry) => entry.isDefault) && store.profiles[0]) {
      store.profiles[0].isDefault = true;
      store.profiles[0].updatedAt = Date.now();
    }
    await this.writeStore(store);
    return true;
  }

  async get(id: string): Promise<ImageGenProfile | null> {
    const store = await this.readStore();
    return store.profiles.find((entry) => entry.id === id) || null;
  }
}
