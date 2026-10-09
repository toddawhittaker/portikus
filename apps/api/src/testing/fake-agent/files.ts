import {
	MAX_EDITOR_FILE_BYTES,
	MAX_TREE_ENTRIES,
	MAX_UPLOAD_BYTES,
	parseTreeAfter,
	treeAfter,
} from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import {
	addParents,
	checkPath,
	contentTypeOf,
	etagOf,
	FakeFileError,
	nodeKey,
	readZipFiles,
} from "./fs-model.js";
import type { FakeAgentState } from "./state.js";

export function registerFileRoutes(app: FastifyInstance, s: FakeAgentState): void {
	const { keyOf, filesForKey, fsOf, fileError, nodeAt, requireParent, noteFsChange } =
		s;
	// The file routes, with the same status codes, etags and conditional
	// write rules as the real agent (SPEC.md §11.1, §11.2, §13.5).

	app.get("/projects/:slug/tree", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		const query = request.query as { path?: string; after?: string };
		const path = query.path ?? "";
		try {
			const node = nodeAt(request, slug, path);
			if (!node) throw new FakeFileError("FILE_NOT_FOUND", "no such directory");
			if (node.type !== "dir") {
				throw new FakeFileError("NOT_A_DIRECTORY", "not a directory");
			}
			const prefix = path === "" ? `${slug}/` : `${slug}/${path}/`;
			const entries = [...fsOf(request)]
				.filter(([key]) => key.startsWith(prefix))
				.filter(([key]) => !key.slice(prefix.length).includes("/"))
				.map(([key, value]) => ({
					name: key.slice(prefix.length),
					type: value.type,
					size: value.type === "file" ? value.content.length : 0,
					mtimeMs: 0,
				}));
			const order = (aDir: boolean, aName: string, bDir: boolean, bName: string) => {
				if (aDir !== bDir) return aDir ? -1 : 1;
				return aName.localeCompare(bName);
			};
			entries.sort((a, b) => order(a.type === "dir", a.name, b.type === "dir", b.name));
			// Pages of MAX_TREE_ENTRIES, like the real agent (SPEC.md §11.2).
			let start = 0;
			if (query.after !== undefined) {
				const last = parseTreeAfter(query.after);
				start = entries.findIndex(
					(entry) => order(entry.type === "dir", entry.name, last.isDir, last.name) > 0,
				);
				if (start === -1) start = entries.length;
			}
			const page = entries.slice(start, start + MAX_TREE_ENTRIES);
			const lastSent = page.at(-1);
			if (start + MAX_TREE_ENTRIES >= entries.length || !lastSent) {
				return { entries: page, truncated: false };
			}
			return {
				entries: page,
				truncated: true,
				next: treeAfter(lastSent.type === "dir", lastSent.name),
			};
		} catch (error) {
			return fileError(reply, error as FakeFileError);
		}
	});

	app.get("/projects/:slug/file", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		const query = request.query as { path?: string; download?: string };
		const path = query.path ?? "";
		try {
			const node = nodeAt(request, slug, path);
			if (!node) throw new FakeFileError("FILE_NOT_FOUND", "no such file");
			if (node.type !== "file") {
				throw new FakeFileError("BAD_REQUEST", "that path is a directory");
			}
			const size = node.apparentSize ?? node.content.length;
			if (query.download !== "1" && size > MAX_EDITOR_FILE_BYTES) {
				throw new FakeFileError(
					"FILE_TOO_LARGE",
					"that file is too large to open here",
				);
			}
			return reply
				.header("etag", etagOf(node.content))
				.header("content-length", String(node.content.length))
				.type(contentTypeOf(node.content))
				.send(node.content);
		} catch (error) {
			return fileError(reply, error as FakeFileError);
		}
	});

	app.put("/projects/:slug/file", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		const path = (request.query as { path?: string }).path ?? "";
		const ifMatch = request.headers["if-match"];
		// Only the literal "*" is a condition, exactly as the real agent reads it.
		const ifNoneMatch = request.headers["if-none-match"] === "*";
		// Fastify parses text/plain itself, so a text write arrives as a string.
		const raw = request.body;
		const body = Buffer.isBuffer(raw)
			? raw
			: Buffer.from(typeof raw === "string" ? raw : "", "utf8");
		try {
			const conditions = (typeof ifMatch === "string" ? 1 : 0) + (ifNoneMatch ? 1 : 0);
			if (conditions !== 1) {
				throw new FakeFileError(
					"BAD_REQUEST",
					"a write needs exactly one of If-Match or If-None-Match",
				);
			}
			const node = nodeAt(request, slug, path);
			if (path === "") throw new FakeFileError("PATH_INVALID", "invalid path");
			if (ifNoneMatch) {
				if (node) throw new FakeFileError("FILE_EXISTS", "that file already exists");
			} else {
				if (!node) throw new FakeFileError("FILE_NOT_FOUND", "no such file");
				if (node.type !== "file") {
					throw new FakeFileError("BAD_REQUEST", "that path is a directory");
				}
				const current = etagOf(node.content);
				const asked = String(ifMatch).replace(/^W\//, "").replace(/^"|"$/g, "");
				// "*" is the HTTP wildcard: any existing file will do.
				if (asked !== "*" && current !== asked) {
					throw new FakeFileError(
						"FILE_CHANGED",
						"the file changed on disk since it was read",
						current,
					);
				}
			}
			requireParent(request, slug, path);
			const contentType = request.headers["content-type"] ?? "";
			const limit = contentType.startsWith("application/octet-stream")
				? MAX_UPLOAD_BYTES
				: MAX_EDITOR_FILE_BYTES;
			if (body.length > limit) {
				throw new FakeFileError("FILE_TOO_LARGE", "that file is too large");
			}
			fsOf(request).set(nodeKey(slug, path), { type: "file", content: body });
			noteFsChange(keyOf(request), slug, [path]);
			const etag = etagOf(body);
			return reply.header("etag", etag).status(200).send({ etag, size: body.length });
		} catch (error) {
			return fileError(reply, error as FakeFileError);
		}
	});

	app.delete("/projects/:slug/file", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		const path = (request.query as { path?: string }).path ?? "";
		try {
			if (path === "") {
				throw new FakeFileError(
					"PATH_INVALID",
					"the project itself cannot be deleted here",
				);
			}
			const node = nodeAt(request, slug, path);
			if (!node) throw new FakeFileError("FILE_NOT_FOUND", "no such file");
			const tree = fsOf(request);
			tree.delete(nodeKey(slug, path));
			if (node.type === "dir") {
				const prefix = `${slug}/${path}/`;
				for (const key of [...tree.keys()]) {
					if (key.startsWith(prefix)) tree.delete(key);
				}
			}
			noteFsChange(keyOf(request), slug, [path]);
			return reply.status(204).send();
		} catch (error) {
			return fileError(reply, error as FakeFileError);
		}
	});

	app.post("/projects/:slug/mkdir", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		const path = (request.body as { path?: string }).path ?? "";
		try {
			if (nodeAt(request, slug, path)) {
				throw new FakeFileError("FILE_EXISTS", "that name is already taken");
			}
			requireParent(request, slug, path);
			fsOf(request).set(nodeKey(slug, path), { type: "dir" });
			noteFsChange(keyOf(request), slug, [path]);
			return reply.status(201).send({ ok: true });
		} catch (error) {
			return fileError(reply, error as FakeFileError);
		}
	});

	// The fake extracts at once, so nothing is ever in progress.
	app.get("/projects/:slug/extract/progress", async () => ({ done: 0, total: 0 }));

	app.post("/projects/:slug/extract", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		const path = (request.body as { path?: string }).path ?? "";
		try {
			checkPath(path);
			const node = nodeAt(request, slug, path);
			if (!node) throw new FakeFileError("FILE_NOT_FOUND", "no such file");
			if (node.type !== "file" || !/\.zip$/i.test(path)) {
				throw new FakeFileError("ARCHIVE_INVALID", "only .zip files can be extracted");
			}
			const files = readZipFiles(node.content);
			const slash = path.lastIndexOf("/");
			const parent = slash < 0 ? "" : path.slice(0, slash);
			const stem = path.slice(slash + 1).replace(/\.zip$/i, "") || "archive";
			let folder = "";
			for (let n = 1; folder === "" || nodeAt(request, slug, folder); n++) {
				const name = n === 1 ? stem : `${stem}-${n}`;
				folder = parent === "" ? name : `${parent}/${name}`;
			}
			const tree = fsOf(request);
			tree.set(nodeKey(slug, folder), { type: "dir" });
			for (const file of files) {
				const inner = `${folder}/${file.name}`;
				addParents(tree, slug, inner);
				tree.set(nodeKey(slug, inner), { type: "file", content: file.data });
			}
			noteFsChange(keyOf(request), slug, [folder]);
			return reply.status(201).send({ path: folder });
		} catch (error) {
			return fileError(reply, error as FakeFileError);
		}
	});

	app.post("/projects/:slug/move", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		const body = request.body as { from?: string; to?: string; replace?: boolean };
		const from = body.from ?? "";
		const to = body.to ?? "";
		try {
			const source = nodeAt(request, slug, from);
			if (!source) throw new FakeFileError("FILE_NOT_FOUND", "no such file");
			const existing = nodeAt(request, slug, to);
			const replaceable =
				body.replace === true &&
				from !== to &&
				source.type === "file" &&
				existing?.type === "file";
			if (existing?.type === "dir" && from !== to) {
				throw new FakeFileError("DIRECTORY_EXISTS", "a folder has that name");
			}
			if (existing && !replaceable) {
				throw new FakeFileError("FILE_EXISTS", "that name is already taken");
			}
			requireParent(request, slug, to);
			const tree = fsOf(request);
			tree.delete(nodeKey(slug, from));
			tree.set(nodeKey(slug, to), source);
			// Everything under a directory moves with it.
			const prefix = `${slug}/${from}/`;
			for (const [key, value] of [...tree]) {
				if (!key.startsWith(prefix)) continue;
				tree.delete(key);
				tree.set(`${slug}/${to}/${key.slice(prefix.length)}`, value);
			}
			noteFsChange(keyOf(request), slug, [from, to]);
			return reply.status(204).send();
		} catch (error) {
			return fileError(reply, error as FakeFileError);
		}
	});

	// Test-only hooks for the filesystem. The path carries the project slug,
	// so seeding is the same shape as the map key.
	app.post("/__test/files", async (request, reply) => {
		const body = request.body as {
			key?: string;
			path: string;
			content: string;
			/** "base64" seeds binary content, such as an image. */
			encoding?: "base64";
			apparentSize?: number;
		};
		const tree = filesForKey(body.key ?? "");
		const [slug, ...rest] = body.path.split("/");
		if (!slug || rest.length === 0) {
			return reply
				.status(400)
				.send({ error: { code: "PATH_INVALID", message: "need <slug>/<path>" } });
		}
		addParents(tree, slug, rest.join("/"));
		tree.set(body.path, {
			type: "file",
			content: Buffer.from(body.content, body.encoding ?? "utf8"),
			...(body.apparentSize === undefined ? {} : { apparentSize: body.apparentSize }),
		});
		noteFsChange(body.key ?? "", slug, [rest.join("/")]);
		return reply.status(204).send();
	});

	app.get("/__test/files", async (request, reply) => {
		const query = request.query as { key?: string; path?: string };
		const node = filesForKey(query.key ?? "").get(query.path ?? "");
		if (node?.type !== "file") {
			return reply
				.status(404)
				.send({ error: { code: "FILE_NOT_FOUND", message: "no such file" } });
		}
		return { content: node.content.toString("utf8") };
	});

	app.delete("/__test/files", async (request, reply) => {
		const query = request.query as { key?: string; path?: string };
		const target = query.path ?? "";
		filesForKey(query.key ?? "").delete(target);
		const [slug, ...rest] = target.split("/");
		if (slug && rest.length > 0) noteFsChange(query.key ?? "", slug, [rest.join("/")]);
		return reply.status(204).send();
	});
}
