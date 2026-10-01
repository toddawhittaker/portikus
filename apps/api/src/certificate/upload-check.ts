import { createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { getCACertificates } from "node:tls";
import type { CertificateUploadCheck } from "@portikus/contracts";

/**
 * The API's first look at an uploaded certificate (SPEC.md 20.1, 24.8),
 * with node:crypto, so the page can say at once which check failed. The
 * root job checks again with openssl and never trusts this one.
 */

export interface UploadRefusal {
	check: CertificateUploadCheck;
	message: string;
}

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
const MAX_CHAIN = 10;

let systemRoots: X509Certificate[] | null = null;
function roots(): X509Certificate[] {
	if (!systemRoots) {
		systemRoots = [];
		for (const pem of getCACertificates("system")) {
			try {
				systemRoots.push(new X509Certificate(pem));
			} catch {
				// A store entry Node cannot parse cannot anchor a chain either.
			}
		}
	}
	return systemRoots;
}

function issuedBy(child: X509Certificate, parent: X509Certificate): boolean {
	return child.checkIssued(parent) && child.verify(parent.publicKey);
}

function spki(key: ReturnType<typeof createPublicKey>): Buffer {
	return key.export({ type: "spki", format: "der" });
}

/**
 * Check one upload: leaf first, then its chain. `privateKey` is absent when
 * the stored key is kept, and then only the job can compare them. Messages
 * never quote the upload. `names` are the host names the certificate must
 * cover, `*.<suffix>` for a wildcard. `trusted` replaces the system store in tests.
 */
export function checkUpload(
	upload: { certificate: string; privateKey?: string | undefined },
	names: string[],
	now: Date = new Date(),
	trusted: X509Certificate[] = roots(),
): UploadRefusal | null {
	const pems = upload.certificate.match(PEM_CERTIFICATE) ?? [];
	let chain: X509Certificate[];
	try {
		if (pems.length === 0) throw new Error("no certificate");
		chain = pems.map((pem) => new X509Certificate(pem));
	} catch {
		return {
			check: "certificate-readable",
			message: "The certificate is not a readable PEM certificate.",
		};
	}
	const leaf = chain[0] as X509Certificate;

	if (upload.privateKey !== undefined) {
		let key: ReturnType<typeof createPrivateKey>;
		try {
			key = createPrivateKey(upload.privateKey);
		} catch {
			return {
				check: "key-readable",
				message: "The private key is not a readable, unencrypted PEM key.",
			};
		}
		if (!spki(createPublicKey(key)).equals(spki(leaf.publicKey))) {
			return {
				check: "key-matches",
				message: "The private key does not match the certificate.",
			};
		}
	}

	// Walk up from the leaf: each step must be signed by an included
	// certificate, until one is self-signed or a system root signed it.
	let current = leaf;
	let complete = false;
	for (let step = 0; step < MAX_CHAIN; step++) {
		if (trusted.some((root) => issuedBy(current, root))) {
			complete = true;
			break;
		}
		if (issuedBy(current, current)) {
			complete = true;
			break;
		}
		const parent = chain.find((c) => c !== current && issuedBy(current, c));
		if (!parent) break;
		current = parent;
	}
	if (!complete) {
		return {
			check: "chain-complete",
			message:
				"The chain does not reach a trusted root. Include every intermediate certificate after the site certificate.",
		};
	}

	for (const cert of chain) {
		if (new Date(cert.validFrom) > now || new Date(cert.validTo) < now) {
			return {
				check: "dates-valid",
				message: "A certificate in the upload is not yet valid or has expired.",
			};
		}
	}

	// A wildcard is covered when any one name under it would be.
	const missing = names.filter((name) => {
		const host = name.startsWith("*.") ? `portikus-check${name.slice(1)}` : name;
		return leaf.checkHost(host) === undefined;
	});
	if (missing.length > 0) {
		return {
			check: "names-cover",
			message: `The certificate does not cover ${missing.join(" and ")}.`,
		};
	}
	return null;
}
