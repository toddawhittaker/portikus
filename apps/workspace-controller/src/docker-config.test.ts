import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "@portikus/observability";
import { beforeEach, describe, expect, test } from "vitest";
import {
	GHCR_CERT_PATH,
	GHCR_HOSTS_MARKER,
	hostsWithGhcr,
	mergeDaemonJson,
	writeDockerConfig,
} from "./docker-config.js";
import { IncusError } from "./incus.js";

const IMAGE_DAEMON = JSON.stringify({
	"storage-driver": "overlay2",
	features: { "containerd-snapshotter": false },
	"log-driver": "local",
});

describe("mergeDaemonJson", () => {
	test("adds the mirror and keeps the storage pin and the image's other keys", () => {
		const merged = JSON.parse(mergeDaemonJson(IMAGE_DAEMON, true));
		expect(merged).toEqual({
			"storage-driver": "overlay2",
			features: { "containerd-snapshotter": false },
			"log-driver": "local",
			"registry-mirrors": ["http://10.200.0.1:5000"],
		});
	});

	test("removes only our mirror when the mirror is off", () => {
		const withOthers = JSON.stringify({
			"registry-mirrors": ["http://10.200.0.1:5000", "https://mirror.example.edu"],
		});
		expect(JSON.parse(mergeDaemonJson(withOthers, false))["registry-mirrors"]).toEqual([
			"https://mirror.example.edu",
		]);
		const onlyOurs = JSON.stringify({ "registry-mirrors": ["http://10.200.0.1:5000"] });
		expect(JSON.parse(mergeDaemonJson(onlyOurs, false))).not.toHaveProperty(
			"registry-mirrors",
		);
	});

	test("puts the pin back when the file lost it, or is missing or broken", () => {
		const changed = JSON.stringify({
			"storage-driver": "vfs",
			features: { "containerd-snapshotter": true, other: true },
		});
		expect(JSON.parse(mergeDaemonJson(changed, false))).toEqual({
			"storage-driver": "overlay2",
			features: { "containerd-snapshotter": false, other: true },
		});
		for (const bad of [null, "{not json", "[]", "null"]) {
			expect(JSON.parse(mergeDaemonJson(bad, false))).toEqual({
				"storage-driver": "overlay2",
				features: { "containerd-snapshotter": false },
			});
		}
	});

	test("never adds the mirror twice", () => {
		const once = mergeDaemonJson(IMAGE_DAEMON, true);
		expect(JSON.parse(mergeDaemonJson(once, true))["registry-mirrors"]).toEqual([
			"http://10.200.0.1:5000",
		]);
	});
});

describe("hostsWithGhcr", () => {
	const base = "127.0.0.1 localhost\n::1 localhost\n";

	test("adds one marked line and removes it again", () => {
		const on = hostsWithGhcr(base, true);
		expect(on).toBe(`${base}10.200.0.1 ghcr.io ${GHCR_HOSTS_MARKER}\n`);
		expect(hostsWithGhcr(on, true)).toBe(on);
		expect(hostsWithGhcr(on, false)).toBe(base);
	});

	test("leaves a student's own ghcr.io line alone", () => {
		const own = `${base}192.0.2.9 ghcr.io\n`;
		expect(hostsWithGhcr(own, false)).toBe(own);
	});
});

/** A container's files as the Incus files API shows them. */
class FakeFiles {
	files = new Map<string, { type: string; content: string }>();
	pushes: string[] = [];
	deletes: string[] = [];

	async readFile(instance: string, path: string) {
		expect(instance).toBe("ws-a");
		const f = this.files.get(path);
		if (!f) throw new IncusError("NOT_FOUND", "not found");
		return { type: f.type, content: Buffer.from(f.content), tooLarge: false };
	}

	async pushFile(
		instance: string,
		path: string,
		body: string,
		opts: { type?: "file" | "directory" },
	) {
		expect(instance).toBe("ws-a");
		this.pushes.push(path);
		this.files.set(path, { type: opts.type ?? "file", content: body });
	}

	async deleteFile(instance: string, path: string) {
		expect(instance).toBe("ws-a");
		if (!this.files.delete(path)) throw new IncusError("NOT_FOUND", "not found");
		this.deletes.push(path);
	}
}

describe("writeDockerConfig", () => {
	let files: FakeFiles;
	let caPath: string;
	const log = silentLogger();

	beforeEach(() => {
		files = new FakeFiles();
		files.files.set("/etc/docker", { type: "directory", content: "" });
		files.files.set("/etc/docker/daemon.json", { type: "file", content: IMAGE_DAEMON });
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
		expect(files.files.get("/etc/hosts")?.content).toBe("127.0.0.1 localhost\n");
		const daemon = JSON.parse(
			files.files.get("/etc/docker/daemon.json")?.content ?? "",
		);
		expect(daemon).not.toHaveProperty("registry-mirrors");
	});

	test("with ghcr off and nothing to remove, touches neither the CA nor /etc/hosts", async () => {
		await writeDockerConfig(
			files,
			"ws-a",
			{ hubMirror: true, ghcr: false },
			{ caPath, log },
		);
		expect(files.pushes).toEqual(["/etc/docker/daemon.json"]);
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

	// A student with root in the container can turn /etc/docker into a link.
	// Every write goes through the instance's own files API, and nothing is
	// written at all through the link.
	test("a symbolic link at /etc/docker stops every write", async () => {
		files.files.set("/etc/docker", { type: "symlink", content: "/home/student/x" });
		await expect(
			writeDockerConfig(
				files,
				"ws-a",
				{ hubMirror: true, ghcr: true },
				{ caPath, log },
			),
		).rejects.toThrow(/not a directory/);
		expect(files.pushes).toEqual([]);
		expect(files.deletes).toEqual([]);
	});

	test("a symbolic link at daemon.json or /etc/hosts is not written through", async () => {
		files.files.set("/etc/docker/daemon.json", { type: "symlink", content: "/x" });
		await expect(
			writeDockerConfig(
				files,
				"ws-a",
				{ hubMirror: true, ghcr: false },
				{ caPath, log },
			),
		).rejects.toThrow(/not a regular file/);
		expect(files.pushes).toEqual([]);

		files.files.set("/etc/docker/daemon.json", { type: "file", content: IMAGE_DAEMON });
		files.files.set("/etc/hosts", { type: "symlink", content: "/x" });
		await expect(
			writeDockerConfig(
				files,
				"ws-a",
				{ hubMirror: true, ghcr: true },
				{ caPath, log },
			),
		).rejects.toThrow(/not a regular file/);
		expect(files.pushes).toEqual([]);
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
