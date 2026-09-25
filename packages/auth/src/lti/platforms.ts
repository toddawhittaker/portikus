import { readFile } from "node:fs/promises";
import { z } from "zod";

/** One LMS registration from the platforms file (docs/archive/epics/EPIC-13.md ruling 14). */
export interface LtiPlatform {
	name: string;
	issuer: string;
	clientId: string;
	authLoginUrl: string;
	keysetUrl: string;
	deploymentIds: string[];
	mock: boolean;
}

const platformSchema = z.strictObject({
	name: z.string().min(1).max(60),
	issuer: z.url(),
	clientId: z.string().min(1),
	authLoginUrl: z.url(),
	keysetUrl: z.url(),
	deploymentIds: z.array(z.string().min(1)).min(1),
	mock: z.boolean(),
});

const fileSchema = z.strictObject({
	version: z.literal(1),
	platforms: z.array(platformSchema).min(1),
});

const URL_FIELDS = ["issuer", "authLoginUrl", "keysetUrl"] as const;

/** Thrown when the platforms file is unreadable or wrong; the message names the problem. */
export class PlatformsFileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PlatformsFileError";
	}
}

/**
 * Validate parsed platforms-file JSON. Throws {@link PlatformsFileError}
 * naming every problem, so the API can refuse to start (ruling 14).
 */
export function parsePlatformsFile(data: unknown): LtiPlatform[] {
	const parsed = fileSchema.safeParse(data);
	if (!parsed.success) {
		const problems = parsed.error.issues.map((issue) => {
			const path = issue.path.join(".");
			return path ? `${path}: ${issue.message}` : issue.message;
		});
		throw new PlatformsFileError(`LTI platforms file: ${problems.join("; ")}`);
	}

	const problems: string[] = [];
	const names = new Set<string>();
	const keys = new Set<string>();
	parsed.data.platforms.forEach((platform, index) => {
		const where = `platforms.${index}`;
		for (const field of URL_FIELDS) {
			const protocol = new URL(platform[field]).protocol;
			const allowed = platform.mock ? ["https:", "http:"] : ["https:"];
			if (!allowed.includes(protocol)) {
				problems.push(
					`${where}.${field}: must be an https URL${platform.mock ? " or http URL" : " (http only when mock is true)"}`,
				);
			}
		}
		if (names.has(platform.name)) {
			problems.push(`${where}.name: duplicate name "${platform.name}"`);
		}
		names.add(platform.name);
		const key = JSON.stringify([platform.issuer, platform.clientId]);
		if (keys.has(key)) {
			problems.push(`${where}: duplicate issuer and clientId`);
		}
		keys.add(key);
	});
	if (problems.length > 0) {
		throw new PlatformsFileError(`LTI platforms file: ${problems.join("; ")}`);
	}
	return parsed.data.platforms;
}

/** Read and validate the platforms file at `path`. */
export async function loadPlatformsFile(path: string): Promise<LtiPlatform[]> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "unreadable";
		throw new PlatformsFileError(`LTI platforms file ${path}: cannot read (${code})`);
	}
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		throw new PlatformsFileError(`LTI platforms file ${path}: not valid JSON`);
	}
	return parsePlatformsFile(data);
}

/**
 * The registration for an issuer and client id. When `clientId` is absent
 * the issuer must have exactly one registration (ruling 19).
 */
export function findPlatform(
	platforms: readonly LtiPlatform[],
	issuer: string,
	clientId: string | undefined,
): LtiPlatform | null {
	const matches = platforms.filter(
		(p) => p.issuer === issuer && (clientId === undefined || p.clientId === clientId),
	);
	return matches.length === 1 ? (matches[0] ?? null) : null;
}
