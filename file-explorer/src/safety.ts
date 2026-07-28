import { constants } from "node:fs";
import { copyFile, cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DomainError } from "./errors.js";
import type { AuthorizedPath } from "./types.js";

export interface BackupRecord {
  id: string;
  rootId: string;
  originalPath: string;
  storedPath: string;
  createdAt: string;
}

export interface TrashRecord {
  id: string;
  rootId: string;
  originalPath: string;
  storedPath: string;
  entryType: "file" | "directory";
  deletedAt: string;
}

async function movePath(source: string, target: string): Promise<void> {
  try {
    await rename(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await cp(source, target, { recursive: true, errorOnExist: true });
    await rm(source, { recursive: true });
  }
}

export class SafetyService {
  constructor(readonly backupDir: string, readonly trashDir: string) {}

  async backup(target: AuthorizedPath): Promise<BackupRecord> {
    const id = randomUUID();
    const storedPath = path.join(this.backupDir, id);
    await mkdir(this.backupDir, { recursive: true });
    await copyFile(target.absolutePath, storedPath, constants.COPYFILE_EXCL);
    const record = { id, rootId: target.root.id, originalPath: target.relativePath, storedPath, createdAt: new Date().toISOString() };
    await writeFile(`${storedPath}.json`, JSON.stringify(record), { flag: "wx" });
    return record;
  }

  async trash(target: AuthorizedPath): Promise<TrashRecord> {
    const id = randomUUID();
    const recordDir = path.join(this.trashDir, id);
    const storedPath = path.join(recordDir, "item");
    await mkdir(recordDir, { recursive: true });
    await movePath(target.absolutePath, storedPath);
    const details = await lstat(storedPath);
    const record: TrashRecord = {
      id, rootId: target.root.id, originalPath: target.relativePath, storedPath,
      entryType: details.isDirectory() ? "directory" : "file",
      deletedAt: new Date().toISOString(),
    };
    await writeFile(path.join(recordDir, "manifest.json"), JSON.stringify(record), { flag: "wx" });
    return record;
  }

  async listTrash(): Promise<TrashRecord[]> {
    await mkdir(this.trashDir, { recursive: true });
    const entries = await readdir(this.trashDir, { withFileTypes: true });
    const records = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => this.readTrash(entry.name)));
    return records.sort((left, right) => right.deletedAt.localeCompare(left.deletedAt));
  }

  async readTrash(id: string): Promise<TrashRecord> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new DomainError("NOT_FOUND", 404, "Trash item does not exist");
    try {
      return JSON.parse(await readFile(path.join(this.trashDir, id, "manifest.json"), "utf8")) as TrashRecord;
    } catch {
      throw new DomainError("NOT_FOUND", 404, "Trash item does not exist");
    }
  }

  async restore(id: string, target: AuthorizedPath): Promise<void> {
    const record = await this.readTrash(id);
    try {
      await lstat(target.absolutePath);
      throw new DomainError("NAME_CONFLICT", 409, "Restore destination already exists");
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await movePath(record.storedPath, target.absolutePath);
    await rm(path.join(this.trashDir, id), { recursive: true, force: true });
  }

  async purge(id: string): Promise<void> {
    await this.readTrash(id);
    await rm(path.join(this.trashDir, id), { recursive: true, force: true });
  }

  async purgeExpired(retentionDays: number, now = Date.now()): Promise<{ trash: number; backups: number }> {
    const cutoff = now - retentionDays * 86_400_000;
    let trash = 0;
    for (const record of await this.listTrash()) {
      if (Date.parse(record.deletedAt) < cutoff) {
        await this.purge(record.id);
        trash += 1;
      }
    }
    await mkdir(this.backupDir, { recursive: true });
    let backups = 0;
    for (const name of await readdir(this.backupDir)) {
      if (!name.endsWith(".json")) continue;
      const manifestPath = path.join(this.backupDir, name);
      try {
        const record = JSON.parse(await readFile(manifestPath, "utf8")) as BackupRecord;
        if (Date.parse(record.createdAt) < cutoff) {
          await Promise.all([rm(record.storedPath, { force: true }), rm(manifestPath, { force: true })]);
          backups += 1;
        }
      } catch {
        continue;
      }
    }
    return { trash, backups };
  }
}
