import { IncusClient, IncusError } from "./incus.js";

export type Entry = { type: string; content: string; mode?: string; uid?: number };

/**
 * A container's files as the Incus files API treats them. It has no
 * readFile on purpose: opening a named pipe would block the controller.
 */
export class FakeFiles {
	files = new Map<string, Entry>();
	ops: string[] = [];

	/** The real delete-then-push, run against this fake's own files. */
	replaceFile = IncusClient.prototype.replaceFile;

	async deleteFile(_instance: string, path: string) {
		const entry = this.files.get(path);
		if (!entry) throw new IncusError("NOT_FOUND", "not found");
		const children = [...this.files.keys()].some((p) => p.startsWith(`${path}/`));
		if (entry.type === "directory" && children) {
			throw new IncusError("OPERATION_FAILED", "directory not empty");
		}
		this.ops.push(`DELETE ${path}`);
		this.files.delete(path);
	}

	async pushFile(
		_instance: string,
		path: string,
		body: string,
		opts: { uid: number; mode: string; type?: "file" | "directory" | "symlink" },
	) {
		const entry = this.files.get(path);
		// Incus answers success for a folder push onto any existing path.
		if (opts.type === "directory" && entry) {
			this.ops.push(`POST ${path}`);
			return;
		}
		const parent = this.files.get(path.slice(0, path.lastIndexOf("/")));
		if (parent && parent.type !== "directory") {
			throw new IncusError("OPERATION_FAILED", "not a directory");
		}
		if (opts.type !== "directory" && entry && entry.type !== "file") {
			throw new Error(`test: pushed onto a ${entry.type}, which would block or follow`);
		}
		this.ops.push(`POST ${path}`);
		this.files.set(path, {
			type: opts.type ?? "file",
			content: body,
			mode: opts.mode,
			uid: opts.uid,
		});
	}
}
