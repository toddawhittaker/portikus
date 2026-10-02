/**
 * The reinstall note (SPEC.md §22.3, ADR 0042). The image's apt hook keeps
 * `~/.portikus/apt-packages.txt`: a first line naming the image it was
 * written on, then the packages the student added. The home survives a
 * rebuild and the system disk does not, so when the file names another
 * image and some of its packages are not installed now, the student is
 * told which ones to put back.
 */
import { randomBytes } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseAptList, type ReinstallNote } from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { sendError } from "./errors.js";

/** Where the image's apt hook writes the list, inside the home. */
const LIST_PATH = ".portikus/apt-packages.txt";

/** The most of the list the agent reads, as the controller does. */
export const LIST_MAX_BYTES = 64 * 1024;

const IMAGE_VERSION = /^[0-9A-Za-z.+~-]{1,64}$/;

export interface PackagesRouteOptions {
	homeDir: string;
	/** Overridden by tests; the image writes its version here. */
	imageVersionPath?: string;
	/** Overridden by tests; dpkg's record of what is installed. */
	dpkgStatusPath?: string;
}

/** The names dpkg records as installed, from its status file. */
export function installedPackages(status: string): Set<string> {
	const installed = new Set<string>();
	for (const stanza of status.split(/\n\s*\n/)) {
		const name = /^Package: (\S+)$/m.exec(stanza)?.[1];
		const state = /^Status: .* (\S+)$/m.exec(stanza)?.[1];
		if (name && state === "installed") installed.add(name);
	}
	return installed;
}

/** The list's text, or null when it is missing, not a regular file, or too big. */
async function readList(homeDir: string): Promise<string | null> {
	const path = join(homeDir, LIST_PATH);
	try {
		const info = await lstat(path);
		if (!info.isFile() || info.size > LIST_MAX_BYTES) return null;
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

/** The running image's version, or null when the image does not say. */
async function currentImage(path: string): Promise<string | null> {
	try {
		const first = (await readFile(path, "utf8")).split("\n")[0]?.trim() ?? "";
		return IMAGE_VERSION.test(first) && first !== "unknown" ? first : null;
	} catch {
		return null;
	}
}

async function reinstallNote(
	options: Required<PackagesRouteOptions>,
): Promise<ReinstallNote> {
	const text = await readList(options.homeDir);
	if (text === null) return { packages: [] };
	const list = parseAptList(text);
	const image = await currentImage(options.imageVersionPath);
	// Without both versions a rebuild cannot be told from a list never refreshed.
	if (!image || !list.image || list.image === image) return { packages: [] };
	const installed = installedPackages(await readFile(options.dpkgStatusPath, "utf8"));
	return { packages: list.packages.filter((name) => !installed.has(name)) };
}

/** Rewrite the header to the running image, so the note does not come back. */
async function dismissReinstallNote(
	options: Required<PackagesRouteOptions>,
): Promise<void> {
	const text = await readList(options.homeDir);
	const image = await currentImage(options.imageVersionPath);
	if (text === null || image === null) return;
	const list = parseAptList(text);
	const path = join(options.homeDir, LIST_PATH);
	const temporary = `${path}.${randomBytes(6).toString("hex")}`;
	try {
		await writeFile(
			temporary,
			[`# portikus-image: ${image}`, ...list.body].join("\n"),
			{
				flag: "wx",
				mode: 0o600,
			},
		);
		// A rename replaces a link at the path itself, never what it points at.
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

/** `GET /packages/reinstall-note` and its dismiss (SPEC.md §22.3). */
export async function packagesRoutes(
	instance: FastifyInstance,
	options: PackagesRouteOptions,
): Promise<void> {
	const resolved: Required<PackagesRouteOptions> = {
		homeDir: options.homeDir,
		imageVersionPath: options.imageVersionPath ?? "/etc/portikus-image-version",
		dpkgStatusPath: options.dpkgStatusPath ?? "/var/lib/dpkg/status",
	};

	instance.get("/packages/reinstall-note", async (request, reply) => {
		try {
			return await reinstallNote(resolved);
		} catch (error) {
			return sendError(request, reply, error, "INTERNAL");
		}
	});

	instance.post("/packages/reinstall-note/dismiss", async (request, reply) => {
		try {
			await dismissReinstallNote(resolved);
			return reply.code(204).send();
		} catch (error) {
			return sendError(request, reply, error, "INTERNAL");
		}
	});
}
