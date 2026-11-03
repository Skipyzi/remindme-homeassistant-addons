import { createHash } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Pictures the owner sent in the console chat, kept so their message shows
 * them. Named by their content's hash, so the same picture twice is one file;
 * a picture no message points to any more goes at the next start.
 */

export type PictureType = "image/jpeg" | "image/png" | "image/webp";

export interface StoredPicture {
	id: string;
	type: PictureType;
}

const EXTENSIONS: Record<PictureType, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const FILE = /^([a-f0-9]{24})\.(jpg|png|webp)$/;

/** The file name a picture is served under: `<id>.<ext>`. */
export function pictureFile(picture: StoredPicture): string {
	return `${picture.id}.${EXTENSIONS[picture.type]}`;
}

export class PictureStore {
	private readonly dir: string;

	constructor(dir = process.env.PICTURES_PATH || "./data/pictures") {
		this.dir = resolve(dir);
	}

	async save(type: PictureType, base64: string): Promise<StoredPicture> {
		if (!(type in EXTENSIONS)) throw new Error("not a picture RemindMe keeps");
		const data = Buffer.from(base64, "base64");
		const picture = { id: createHash("sha256").update(data).digest("hex").slice(0, 24), type };
		await mkdir(this.dir, { recursive: true });
		await writeFile(join(this.dir, pictureFile(picture)), data, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "EEXIST") throw error;
		});
		return picture;
	}

	/** The full path of a served file name, or undefined for anything that isn't one of ours. */
	path(name: string): string | undefined {
		return FILE.test(name) ? join(this.dir, name) : undefined;
	}

	/** Remove pictures no message points to; ones from the last hour stay, as their message may still be on its way. */
	async prune(keep: Set<string>, now = Date.now()): Promise<number> {
		let removed = 0;
		for (const name of await readdir(this.dir).catch(() => [] as string[])) {
			const id = FILE.exec(name)?.[1];
			if (!id || keep.has(id)) continue;
			const path = join(this.dir, name);
			const { mtimeMs } = await stat(path);
			if (now - mtimeMs < 3_600_000) continue;
			await unlink(path);
			removed++;
		}
		return removed;
	}
}
