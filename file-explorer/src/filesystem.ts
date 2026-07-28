import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DomainError } from "./errors.js";
import type { SafetyService } from "./safety.js";
import type { AuthorizedPath, EntryMetadata } from "./types.js";

function createSignature(size: number, modifiedMs: number): string {
  return createHash("sha256").update(`${size}:${modifiedMs}`).digest("hex");
}

function entryType(details: Awaited<ReturnType<typeof lstat>>): EntryMetadata["type"] {
  if (details.isSymbolicLink()) return "symlink";
  if (details.isDirectory()) return "directory";
  return "file";
}

export class FilesystemService {
  async metadata(target: AuthorizedPath): Promise<EntryMetadata> {
    const details = await lstat(target.absolutePath);
    return {
      name: path.basename(target.absolutePath),
      path: target.relativePath,
      type: entryType(details),
      size: details.size,
      modifiedAt: details.mtime.toISOString(),
      signature: createSignature(details.size, details.mtimeMs),
    };
  }

  async list(target: AuthorizedPath): Promise<EntryMetadata[]> {
    const entries = await readdir(target.absolutePath, { withFileTypes: true });
    const metadata = await Promise.all(entries.map(async (entry) => {
      const relativePath = path.posix.join(target.relativePath, entry.name);
      return this.metadata({ ...target, relativePath, absolutePath: path.join(target.absolutePath, entry.name) });
    }));
    return metadata.sort((left, right) => {
      if (left.type === "directory" && right.type !== "directory") return -1;
      if (left.type !== "directory" && right.type === "directory") return 1;
      return left.name.localeCompare(right.name);
    });
  }

  async readText(target: AuthorizedPath, maxBytes: number) {
    const details = await stat(target.absolutePath);
    if (!details.isFile()) throw new DomainError("UNSUPPORTED_FILE", 415, "Path is not a regular file");
    if (details.size > maxBytes) {
      throw new DomainError("TOO_LARGE", 413, "File exceeds the text-editing limit");
    }
    const data = await readFile(target.absolutePath);
    if (data.includes(0)) throw new DomainError("UNSUPPORTED_FILE", 415, "File is not supported text");
    return {
      content: data.toString("utf8"),
      encoding: "utf-8" as const,
      signature: createSignature(details.size, details.mtimeMs),
    };
  }

  download(target: AuthorizedPath) {
    return createReadStream(target.absolutePath);
  }

  async createDirectory(target: AuthorizedPath): Promise<EntryMetadata> {
    try {
      await mkdir(target.absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new DomainError("NAME_CONFLICT", 409, "Destination already exists");
      }
      throw error;
    }
    return this.metadata(target);
  }

  async createFile(target: AuthorizedPath): Promise<EntryMetadata> {
    try {
      await writeFile(target.absolutePath, "", { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new DomainError("NAME_CONFLICT", 409, "Destination already exists");
      }
      throw error;
    }
    return this.metadata(target);
  }

  async saveAtomic(
    target: AuthorizedPath,
    content: string,
    expectedSignature: string,
    safety: SafetyService,
    maxBytes: number,
  ) {
    if (Buffer.byteLength(content) > maxBytes) throw new DomainError("TOO_LARGE", 413, "Content exceeds the text-editing limit");
    const current = await this.metadata(target);
    if (current.signature !== expectedSignature) {
      throw new DomainError("FILE_CHANGED", 409, "File changed after it was opened");
    }
    const backup = await safety.backup(target);
    const temporary = `${target.absolutePath}.file-explorer-${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, target.absolutePath);
      return { metadata: await this.metadata(target), backup };
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async receiveUpload(
    target: AuthorizedPath,
    source: AsyncIterable<Uint8Array>,
    maxBytes: number,
  ): Promise<EntryMetadata> {
    try {
      await lstat(target.absolutePath);
      throw new DomainError("NAME_CONFLICT", 409, "Destination already exists");
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = `${target.absolutePath}.file-explorer-${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let total = 0;
    try {
      handle = await open(temporary, "wx", 0o600);
      for await (const chunk of source) {
        total += chunk.byteLength;
        if (total > maxBytes) throw new DomainError("TOO_LARGE", 413, "Upload exceeds the configured limit");
        await handle.write(chunk);
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, target.absolutePath);
      return this.metadata(target);
    } finally {
      await handle?.close();
      await rm(temporary, { force: true });
    }
  }

  async move(source: AuthorizedPath, target: AuthorizedPath): Promise<EntryMetadata> {
    try {
      await lstat(target.absolutePath);
      throw new DomainError("NAME_CONFLICT", 409, "Destination already exists");
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rename(source.absolutePath, target.absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      await cp(source.absolutePath, target.absolutePath, { recursive: true, errorOnExist: true });
      await rm(source.absolutePath, { recursive: true });
    }
    return this.metadata(target);
  }
}
