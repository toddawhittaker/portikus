import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { writeDexGrpcCerts } from "./fake-dex-grpc.js";

// A client certificate that expired on 2026-09-27.
const EXPIRED_CERT = `-----BEGIN CERTIFICATE-----
MIIBfzCCASWgAwIBAgIUKV1jIGSofmdRHdZchR5HS44quSYwCgYIKoZIzj0EAwIw
ETEPMA0GA1UEAwwGZTJlLWNhMB4XDTI2MDkyNTE5NDE0OVoXDTI2MDkyNzE5NDE0
OVowFTETMBEGA1UEAwwKZTJlLWNsaWVudDBZMBMGByqGSM49AgEGCCqGSM49AwEH
A0IABEI44xAEcgnheAvvRsttmVaqciZ8bO4tvHThFE5/r/6aDg3jg+L1NplMxaSI
KvhI4GPd9yHERupYVl5OsQxvU0ajVzBVMBMGA1UdJQQMMAoGCCsGAQUFBwMCMB0G
A1UdDgQWBBRJO25rq4DkSBkKsI/Ln24tZrPYVTAfBgNVHSMEGDAWgBTnNXFdCpio
ZYFkvaM3kCxzEEDelzAKBggqhkjOPQQDAgNIADBFAiEA/NWnwTujsQL/eLT3A4q4
YdpvM+VIsiVTsNeAhd1TtRUCIBQyM1nyxqdCI1Vb8PoLuyAZbqiVYfzsx2PP33tc
84SX
-----END CERTIFICATE-----
`;

function validForADay(path: string): boolean {
	try {
		execFileSync("openssl", ["x509", "-in", path, "-noout", "-checkend", "86400"], {
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
}

describe("writeDexGrpcCerts", () => {
	let dir = "";
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test("replaces cached certificates that have expired", () => {
		dir = mkdtempSync(join(tmpdir(), "fake-dex-certs-"));
		const first = writeDexGrpcCerts(dir);
		writeFileSync(first.clientCert, EXPIRED_CERT);
		writeFileSync(first.serverCert, EXPIRED_CERT);

		const second = writeDexGrpcCerts(dir);
		expect(validForADay(second.clientCert)).toBe(true);
		expect(validForADay(second.serverCert)).toBe(true);
	});
});
