import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "@portikus/observability";
import { beforeEach, describe, expect, test } from "vitest";
import {
	daemonJson,
	GHCR_CERT_PATH,
	GHCR_HOSTS_MARKER,
	workspaceHosts,
	writeDockerConfig,
} from "./docker-config.js";
import { IncusError } from "./incus.js";

describe("daemonJson", () => {
	test("keeps the storage pin and adds the mirror only when on", () => {
		expect(JSON.parse(daemonJson(true))).toEqual({
			"storage-driver": "overlay2",
			features: { "containerd-snapshotter": false },
			"registry-mirrors": ["http://10.200.0.1:5000"],
		});
		expect(JSON.parse(daemonJson(false))).toEqual({
			"storage-driver": "overlay2",
			features: { "containerd-snapshotter": false },
		});
	});
});

describe("workspaceHosts", () => {
	test("names the instance and adds one marked ghcr.io line when on", () => {
		const off = workspaceHosts("ws-a", false);
		expect(off).toContain("127.0.0.1 localhost\n127.0.1.1 ws-a\n");
		expect(off).not.toContain("ghcr.io");
		const on = workspaceHosts("ws-a", true);
		expect(on).toBe(`${off}10.200.0.1 ghcr.io ${GHCR_HOSTS_MARKER}\n`);
	});
});

/**
 * A container's files as the Incus files API treats them. It has no
 * readFile on purpose: opening a named pipe would block the controller.
 */
class FakeFiles {
	files = new Map<string, { type: string; content: string }>();
	ops: string[] = [];

	async pushFile(
		instance: string,
		path: string,
		body: string,
		opts: { type?: "file" | "directory" },
	) {
		expect(instance).toBe("ws-a");
		const entry = this.files.get(path);
		if (opts.type === "directory" && entry && entry.type !== "directory") {
			throw new IncusError("OPERATION_FAILED", "not a directory");
		}
		if (opts.type !== "directory" && entry && entry.type !== "file") {
			throw new Error(`test: pushed onto a ${entry.type}, which would block or follow`);
		}
		this.ops.push(`POST ${path}`);
		this.files.set(path, { type: opts.type ?? "file", content: body });
	}

	async deleteFile(instance: string, path: string) {
		expect(instance).toBe("ws-a");
		const entry = this.files.get(path);
		if (!entry) throw new IncusError("NOT_FOUND", "not found");
		const children = [...this.files.keys()].some((p) => p.startsWith(`${path}/`));
		if (entry.type === "directory" && children) {
			throw new IncusError("OPERATION_FAILED", "directory not empty");
		}
		this.ops.push(`DELETE ${path}`);
		this.files.delete(path);
	}
}

describe("writeDockerConfig", () => {
	let files: FakeFiles;
	let caPath: string;
	const log = silentLogger();

	beforeEach(() => {
		files = new FakeFiles();
		files.files.set("/etc/docker", { type: "directory", content: "" });
		files.files.set("/etc/docker/daemon.json", { type: "file", content: "{}" });
		files.files.set("/etc/hosts", { type: "file", content: "127.0.0.1 localhost\n" });
		caPath = join(mkdtempSync(join(tmpdir(), "ghcr-ca-")), "ca.crt");
		writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\nx\n");
	});

	test("with ghcr on, writes the mirror, the CA under certs.d and the hosts line", async () => {
		await writeDockerConfig(
			files,
			"ws-a",
			{ hubMirror: true, ghcr: true },
			{ caPath, log },
		);
		const daemon = JSON.parse(
			files.files.get("/etc/docker/daemon.json")?.content ?? "",
		);
		expect(daemon["registry-mirrors"]).toEqual(["http://10.200.0.1:5000"]);
		expect(daemon["storage-driver"]).toBe("overlay2");
		expect(files.files.get(GHCR_CERT_PATH)?.content).toContain("BEGIN CERTIFICATE");
		expect(files.files.get("/etc/docker/certs.d/ghcr.io")?.type).toBe("directory");
		expect(files.files.get("/etc/hosts")?.content).toContain("10.200.0.1 ghcr.io");
	});

	test("with ghcr off, removes the CA and the hosts line", async () => {
		await writeDockerConfig(
			files,
			"ws-a",
			{ hubMirror: true, ghcr: true },
			{ caPath, log },
		);
		await writeDockerConfig(
			files,
			"ws-a",
			{ hubMirror: false, ghcr: false },
			{ caPath, log },
		);
		expect(files.files.has(GHCR_CERT_PATH)).toBe(false);
		expect(files.files.get("/etc/hosts")?.content).toBe(workspaceHosts("ws-a", false));
		const daemon = JSON.parse(
			files.files.get("/etc/docker/daemon.json")?.content ?? "",
		);
		expect(daemon).not.toHaveProperty("registry-mirrors");
	});

	test("an unreadable CA leaves ghcr.io uncached rather than half set up", async () => {
		await writeDockerConfig(
			files,
			"ws-a",
			{ hubMirror: true, ghcr: true },
			{ caPath: join(tmpdir(), "no-such-ca.crt"), log },
		);
		expect(files.files.has(GHCR_CERT_PATH)).toBe(false);
		expect(files.files.get("/etc/hosts")?.content).not.toContain("ghcr.io");
	});

	test("with the cache off, writes no mirror and no ghcr.io entry even when asked", async () => {
		const cacheOffPath = join(mkdtempSync(join(tmpdir(), "cache-off-")), "cache-off");
		writeFileSync(cacheOffPath, "off\n");
		await writeDockerConfig(
			files,
			"ws-a",
			{ hubMirror: true, ghcr: true },
			{ caPath, cacheOffPath, log },
		);
		const daemon = JSON.parse(
			files.files.get("/etc/docker/daemon.json")?.content ?? "",
		);
		expect(daemon).not.toHaveProperty("registry-mirrors");
		expect(files.files.has(GHCR_CERT_PATH)).toBe(false);
		expect(files.files.get("/etc/hosts")?.content).not.toContain("ghcr.io");
	});

	test("with no cache-off marker, writes the mirror and ghcr.io entry as asked", async () => {
		await writeDockerConfig(
			files,
			"ws-a",
			{ hubMirror: true, ghcr: true },
			{ caPath, cacheOffPath: join(tmpdir(), "no-such-cache-off"), log },
		);
		const daemon = JSON.parse(
			files.files.get("/etc/docker/daemon.json")?.content ?? "",
		);
		expect(daemon["registry-mirrors"]).toEqual(["http://10.200.0.1:5000"]);
		expect(files.files.get("/etc/hosts")?.content).toContain("10.200.0.1 ghcr.io");
	});

	// A student with root in the container can leave a named pipe; opening one blocks.
	test("a pipe, link or other type at a file is deleted then written, never opened", async () => {
		for (const type of ["fifo", "symlink", "socket"]) {
			files.ops = [];
			for (const p of ["/etc/docker/daemon.json", "/etc/hosts", GHCR_CERT_PATH]) {
				files.files.set(p, { type, content: "" });
			}
			await writeDockerConfig(
				files,
				"ws-a",
				{ hubMirror: true, ghcr: true },
				{ caPath, log },
			);
			for (const p of ["/etc/docker/daemon.json", "/etc/hosts", GHCR_CERT_PATH]) {
				expect(files.ops.indexOf(`DELETE ${p}`)).toBeLessThan(
					files.ops.indexOf(`POST ${p}`),
				);
				expect(files.files.get(p)?.type).toBe("file");
			}
		}
	});

	test("anything but a folder at /etc/docker stops every file write", async () => {
		files.files.set("/etc/docker", { type: "fifo", content: "" });
		await expect(
			writeDockerConfig(
				files,
				"ws-a",
				{ hubMirror: true, ghcr: true },
				{ caPath, log },
			),
		).rejects.toThrow(/not a directory/);
		expect(files.ops).toEqual([]);
	});

	test("a directory at daemon.json is refused", async () => {
		files.files.set("/etc/docker/daemon.json", { type: "directory", content: "" });
		files.files.set("/etc/docker/daemon.json/x", { type: "file", content: "" });
		await expect(
			writeDockerConfig(
				files,
				"ws-a",
				{ hubMirror: true, ghcr: false },
				{ caPath, log },
			),
		).rejects.toThrow(/cannot be replaced/);
	});

	test("a missing daemon.json is written with the pin", async () => {
		files.files.delete("/etc/docker/daemon.json");
		await writeDockerConfig(
			files,
			"ws-a",
			{ hubMirror: false, ghcr: false },
			{ caPath, log },
		);
		expect(
			JSON.parse(files.files.get("/etc/docker/daemon.json")?.content ?? ""),
		).toEqual({
			"storage-driver": "overlay2",
			features: { "containerd-snapshotter": false },
		});
	});
});
