import {
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_PORT } from "./ports";

/**
 * A fake host for the Certificate tab (docs/SPEC.md section 20.1; ADR 0046).
 * The API writes request files into CERTIFICATE_JOBS_DIR and reads the
 * status directory beside it; the tests play the root job by hand: they take the
 * request file and write the record, status and log the real job would.
 * Keyed by the API's port so two runs on one machine never share it.
 */
const CERTIFICATE_ROOT = join(tmpdir(), `portikus-e2e-certificate-${API_PORT}`);
export const CERTIFICATE_JOBS_DIR = join(CERTIFICATE_ROOT, "certificate-jobs");
export const CERTIFICATE_STATUS_DIR = join(CERTIFICATE_ROOT, "certificate");

/** Write then rename, as the root job does, so the API never reads half a file. */
async function writeAtomic(path: string, text: string): Promise<void> {
	await writeFile(`${path}.tmp`, text);
	await rename(`${path}.tmp`, path);
}

/** Empty both directories. */
export async function resetCertificateStore(): Promise<void> {
	await rm(CERTIFICATE_ROOT, { recursive: true, force: true });
	await mkdir(CERTIFICATE_JOBS_DIR, { recursive: true });
	await mkdir(CERTIFICATE_STATUS_DIR, { recursive: true });
}

/** What the hourly check would write: one certificate for the site and previews. */
export async function putStatus(over: {
	/** The settings in force, as `CertificateSettingsView`; internal when left out. */
	settings?: { source: "internal" | "acme" | "files" } & Record<string, unknown>;
	previousAvailable?: boolean;
	issuer?: string;
	notAfter?: string;
	renewal?: { ok: boolean; message: string | null } | null;
	/** What the hourly check writes while the internal authority serves a public address. */
	internalOnPublic?: { since: string; addresses: string[] } | null;
}): Promise<void> {
	const settings = over.settings ?? { source: "internal" };
	const info = (name: string) => ({
		name,
		issuer: over.issuer ?? "CN=Caddy Local Authority - ECC Intermediate",
		names: ["localhost", "*.preview.localhost"],
		notBefore: "2026-09-01T00:00:00.000Z",
		notAfter: over.notAfter ?? "2026-11-30T00:00:00.000Z",
	});
	await writeAtomic(
		join(CERTIFICATE_STATUS_DIR, "status.json"),
		JSON.stringify({
			checkedAt: new Date().toISOString(),
			source: settings.source,
			// The job copies settings.json here, because the API cannot read the state directory.
			settings,
			previousAvailable: over.previousAvailable ?? false,
			site: info("localhost"),
			preview: info("sample.preview.localhost"),
			lastRenewal: over.renewal
				? { ...over.renewal, at: new Date().toISOString() }
				: null,
			internalOnPublic: over.internalOnPublic ?? null,
		}),
	);
}

/** Caddy's internal root as the job copies it for the admin download. */
export const FAKE_ROOT_PEM =
	"-----BEGIN CERTIFICATE-----\nMIIBfakeRootForTests\n-----END CERTIFICATE-----\n";

export async function putRoot(): Promise<void> {
	await writeAtomic(join(CERTIFICATE_STATUS_DIR, "root.crt"), FAKE_ROOT_PEM);
}

export async function requestFiles(): Promise<string[]> {
	return (await readdir(CERTIFICATE_JOBS_DIR)).filter((n) =>
		/^request-.*\.json$/.test(n),
	);
}

/** Every secret becomes a "set" flag, as the job's record of a request does. */
function recordOf(request: { kind: string; settings?: Record<string, unknown> }) {
	const settings = request.settings as
		| {
				source: string;
				directory?: string;
				email?: string;
				eab?: { keyId: string; hmacKey?: string };
				challenge?: {
					mode: string;
					dns?: { provider: string; fields: Record<string, string> };
				};
		  }
		| undefined;
	if (!settings) return { kind: request.kind, settings: null };
	if (settings.source === "internal") return { kind: request.kind, settings };
	if (settings.source === "files") {
		const view = {
			certificate: {
				issuer: "CN=Uploaded",
				names: ["localhost"],
				notBefore: "2026-09-01T00:00:00.000Z",
				notAfter: "2027-09-01T00:00:00.000Z",
			},
			privateKeySet: true,
		};
		return {
			kind: request.kind,
			settings: { source: "files", site: view, preview: null },
		};
	}
	const challenge = settings.challenge;
	return {
		kind: request.kind,
		settings: {
			source: "acme",
			directory: settings.directory,
			email: settings.email,
			eab: settings.eab ? { keyId: settings.eab.keyId, hmacKeySet: true } : null,
			challenge:
				challenge?.mode === "dns01" && challenge.dns
					? {
							mode: "dns01",
							provider: challenge.dns.provider,
							fields: {},
							secretsSet: Object.fromEntries(
								Object.keys(challenge.dns.fields).map((k) => [k, true]),
							),
						}
					: { mode: "http01" },
		},
	};
}

/**
 * Wait for the API's request file and take it, as the root job does first:
 * the request (secrets and all) is returned to the test, and only the record
 * without secrets stays on disk.
 */
export async function takeRequest(): Promise<{
	id: string;
	mode: number;
	request: { kind: string; settings?: Record<string, unknown> };
}> {
	for (let tries = 0; tries < 100; tries++) {
		const name = (await requestFiles())[0];
		if (name) {
			const path = join(CERTIFICATE_JOBS_DIR, name);
			const mode = (await stat(path)).mode & 0o777;
			const file = JSON.parse(await readFile(path, "utf8"));
			await mkdir(join(CERTIFICATE_JOBS_DIR, file.id), { recursive: true });
			await writeAtomic(
				join(CERTIFICATE_JOBS_DIR, file.id, "request.json"),
				JSON.stringify(recordOf(file.request)),
			);
			await rm(path);
			return { id: file.id, mode, request: file.request };
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("the API wrote no request file");
}

export async function writeStatus(
	id: string,
	kind: string | null,
	state: "running" | "succeeded" | "failed" | "refused",
	step: string,
	over: { message?: string | null; restored?: boolean } = {},
): Promise<void> {
	await mkdir(join(CERTIFICATE_JOBS_DIR, id), { recursive: true });
	await writeAtomic(
		join(CERTIFICATE_JOBS_DIR, id, "status.json"),
		JSON.stringify({
			id,
			kind,
			state,
			step,
			message: over.message ?? null,
			restored: over.restored ?? false,
			startedAt: new Date().toISOString(),
			finishedAt: state === "running" ? null : new Date().toISOString(),
		}),
	);
}

export async function writeLog(id: string, lines: string[]): Promise<void> {
	await writeAtomic(join(CERTIFICATE_JOBS_DIR, id, "log.txt"), `${lines.join("\n")}\n`);
}
