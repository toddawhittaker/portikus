import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const main = fileURLToPath(new URL("./reset-admin-main.ts", import.meta.url));

test("unreadable Dex gRPC files exit 2 with one line, no stack trace", () => {
	const result = spawnSync(process.execPath, ["--import", "tsx", main], {
		encoding: "utf8",
		env: {
			...process.env,
			DATABASE_URL: "postgres://localhost/unused",
			DEX_GRPC_ADDR: "127.0.0.1:5557",
			DEX_GRPC_CA: "/nonexistent/ca.crt",
			DEX_GRPC_CERT: "/nonexistent/client.crt",
			DEX_GRPC_KEY: "/nonexistent/client.key",
		},
	});
	expect(result.status).toBe(2);
	expect(result.stdout).toBe("");
	const lines = result.stderr.split("\n").filter(Boolean);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toContain("Dex gRPC");
	expect(result.stderr).not.toMatch(/\n\s+at /);
});
