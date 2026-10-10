import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "@portikus/observability";
import { beforeEach, describe, expect, test } from "vitest";
import {
	DOCKER_SLICE,
	daemonJson,
	GHCR_CERT_PATH,
	GHCR_HOSTS_MARKER,
	HOSTS_EDIT_SCRIPT,
	writeDockerConfig,
	writeGhcrHosts,
} from "./docker-config.js";
import { IncusClient, IncusError } from "./incus.js";

describe("daemonJson", () => {
	test("is the image's storage pin and Docker slice, with our mirror only when on", () => {
		expect(JSON.parse(daemonJson(true))).toEqual({
			"storage-driver": "overlay2",
			features: { "containerd-snapshotter": false },
			"cgroup-parent": "portikus-docker.slice",
			"registry-mirrors": ["http://10.200.0.1:5000"],
		});
		expect(JSON.parse(daemonJson(false))).toEqual({
			"storage-driver": "overlay2",
			features: { "containerd-snapshotter": false },
			"cgroup-parent": "portikus-docker.slice",
		});
	});

	// A workspace started before the controller first writes the file runs the image's own.
	test("without the mirror is what the workspace image writes", () => {
		const entry = recipe().split("- path: /etc/docker/daemon.json")[1] ?? "";
		const imageContent = entry.split("content: |-\n")[1]?.split("\n")[0]?.trim();
		expect(JSON.parse(imageContent ?? "")).toEqual(JSON.parse(daemonJson(false)));
	});

	// Docker's containers share the workspace's process ceiling with the agent
	// and the terminals, so together they get at most half of it (SPEC.md 19.3).
	test("the image caps the Docker slice at half the workspace's process ceiling or less", () => {
		const entry =
			recipe().split(`- path: /etc/systemd/system/${DOCKER_SLICE}\n`)[1] ?? "";
		const unit = entry.split("\n- path:")[0] ?? "";
		const tasksMax = Number(/^ {4}TasksMax=(\d+)$/m.exec(unit)?.[1]);
		const site = readFileSync(
			join(import.meta.dirname, "../../../infra/ansible/site.yml"),
			"utf8",
		);
		const ceiling = Number(/^\s*workspace_process_limit: "?(\d+)"?$/m.exec(site)?.[1]);
		expect(tasksMax).toBeGreaterThan(0);
		expect(tasksMax).toBeLessThanOrEqual(ceiling / 2);
	});
});

function recipe(): string {
	return readFileSync(
		join(import.meta.dirname, "../../../infra/workspace-image/portikus.yaml"),
		"utf8",
	);
}

/**
 * A container's files as the Incus files API treats them on a real host:
 * a push opens the path for writing, which never returns for a named pipe,
 * so this fake fails the test instead. It has no read at all, because the
 * controller must not have one (SPEC.md §24).
 */
class FakeFiles {
	files = new Map<string, { type: string; content: string }>();
	pushes: string[] = [];
	deletes: string[] = [];

	async pushFile(
		instance: string,
		path: string,
		body: string,
		opts: { type?: "file" | "directory" | "symlink" },
	) {
		expect(instance).toBe("ws-a");
		const existing = this.files.get(path);
		if (opts.type !== "directory" && existing?.type === "fifo") {
			throw new Error(`opened the named pipe at ${path}`);
		}
		this.pushes.push(path);
		if (opts.type === "directory" && existing) return;
		this.files.set(path, { type: opts.type ?? "file", content: body });
	}

	/** The real delete-then-push, run against this fake's own files. */
	replaceFile = IncusClient.prototype.replaceFile;

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
		files.files.set("/etc/docker/daemon.json", {
			type: "file",
			content: daemonJson(false),
		});
		caPath = join(mkdtempSync(join(tmpdir(), "ghcr-ca-")), "ca.crt");
		writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\nx\n");
	});

	test("with ghcr on, writes the mirror and the CA under certs.d", async () => {
		expect(
			await writeDockerConfig(
				files,
				"ws-a",
				{ hubMirror: true, ghcr: true },
				{ caPath, log },
			),
		).toBe(true);
		expect(files.files.get("/etc/docker/daemon.json")?.content).toBe(daemonJson(true));
		expect(files.files.get(GHCR_CERT_PATH)?.content).toContain("BEGIN CERTIFICATE");
		expect(files.files.get("/etc/docker/certs.d/ghcr.io")?.type).toBe("directory");
	});

	test("with ghcr off, removes the CA and the mirror", async () => {
		await writeDockerConfig(
			files,
			"ws-a",
			{ hubMirror: true, ghcr: true },
			{ caPath, log },
		);
		expect(
			await writeDockerConfig(
				files,
				"ws-a",
				{ hubMirror: false, ghcr: false },
				{ caPath, log },
			),
		).toBe(false);
		expect(files.files.has(GHCR_CERT_PATH)).toBe(false);
		expect(files.files.get("/etc/docker/daemon.json")?.content).toBe(daemonJson(false));
	});

	test("an unreadable CA leaves ghcr.io uncached rather than half set up", async () => {
		expect(
			await writeDockerConfig(
				files,
				"ws-a",
				{ hubMirror: true, ghcr: true },
				{ caPath: join(tmpdir(), "no-such-ca.crt"), log },
			),
		).toBe(false);
		expect(files.files.has(GHCR_CERT_PATH)).toBe(false);
	});

	test("with the cache off, writes no mirror and no ghcr.io CA even when asked", async () => {
		const cacheOffPath = join(mkdtempSync(join(tmpdir(), "cache-off-")), "cache-off");
		writeFileSync(cacheOffPath, "off\n");
		expect(
			await writeDockerConfig(
				files,
				"ws-a",
				{ hubMirror: true, ghcr: true },
				{ caPath, cacheOffPath, log },
			),
		).toBe(false);
		expect(files.files.get("/etc/docker/daemon.json")?.content).toBe(daemonJson(false));
		expect(files.files.has(GHCR_CERT_PATH)).toBe(false);
	});

	test("with no cache-off marker, writes the mirror as asked", async () => {
		await writeDockerConfig(
			files,
			"ws-a",
			{ hubMirror: true, ghcr: true },
			{ caPath, cacheOffPath: join(tmpdir(), "no-such-cache-off"), log },
		);
		expect(files.files.get("/etc/docker/daemon.json")?.content).toBe(daemonJson(true));
	});

	// Incus reports a named pipe as a regular file, so nothing may be read
	// first; each path is deleted, then written whole.
	test("named pipes at daemon.json and the CA are replaced, never opened", async () => {
		files.files.set("/etc/docker/daemon.json", { type: "fifo", content: "" });
		files.files.set(GHCR_CERT_PATH, { type: "fifo", content: "" });
		await writeDockerConfig(
			files,
			"ws-a",
			{ hubMirror: true, ghcr: true },
			{ caPath, log },
		);
		expect(files.files.get("/etc/docker/daemon.json")).toEqual({
			type: "file",
			content: daemonJson(true),
		});
		expect(files.files.get(GHCR_CERT_PATH)).toEqual({
			type: "file",
			content: "-----BEGIN CERTIFICATE-----\nx\n",
		});
	});

	test("a missing /etc/docker or daemon.json is made again", async () => {
		files.files.clear();
		await writeDockerConfig(
			files,
			"ws-a",
			{ hubMirror: false, ghcr: false },
			{ caPath, log },
		);
		expect(files.files.get("/etc/docker")?.type).toBe("directory");
		expect(files.files.get("/etc/docker/daemon.json")?.content).toBe(daemonJson(false));
	});
});

describe("writeGhcrHosts", () => {
	test("runs the hosts edit inside the container with our line, under timeout", async () => {
		const calls: Array<{ name: string; command: string[] }> = [];
		const client = {
			async exec(name: string, command: string[]) {
				calls.push({ name, command });
				return { status: 0, stdout: Buffer.alloc(0), tooLarge: false };
			},
		};
		await writeGhcrHosts(client, "ws-a", true);
		await writeGhcrHosts(client, "ws-a", false);
		expect(calls.map((c) => c.name)).toEqual(["ws-a", "ws-a"]);
		expect(calls[0]?.command).toEqual([
			"timeout",
			"10",
			"sh",
			"-c",
			HOSTS_EDIT_SCRIPT,
			"sh",
			`10.200.0.1 ghcr.io ${GHCR_HOSTS_MARKER}`,
			`${GHCR_HOSTS_MARKER}$`,
			"/etc/hosts",
		]);
		expect(calls[1]?.command[6]).toBe("");
	});

	test("a failed edit is an error", async () => {
		const client = {
			async exec() {
				return { status: 124, stdout: Buffer.alloc(0), tooLarge: false };
			},
		};
		await expect(writeGhcrHosts(client, "ws-a", true)).rejects.toThrow(/exited 124/);
	});
});

describe("the hosts edit script", () => {
	const line = `10.200.0.1 ghcr.io ${GHCR_HOSTS_MARKER}`;
	let hosts: string;

	/** Run the script as the container would, against a file of our own. */
	function edit(add: string): void {
		execFileSync(
			"timeout",
			["5", "sh", "-c", HOSTS_EDIT_SCRIPT, "sh", add, `${GHCR_HOSTS_MARKER}$`, hosts],
			{ stdio: "ignore" },
		);
	}

	beforeEach(() => {
		hosts = join(mkdtempSync(join(tmpdir(), "hosts-")), "hosts");
	});

	test("adds one marked line, keeps the student's lines, and removes it again", () => {
		const own = "127.0.0.1 localhost\n10.0.0.5 myapp.test\n192.0.2.9 ghcr.io\n";
		writeFileSync(hosts, own);
		edit(line);
		expect(readFileSync(hosts, "utf8")).toBe(`${own}${line}\n`);
		edit(line);
		expect(readFileSync(hosts, "utf8")).toBe(`${own}${line}\n`);
		edit("");
		expect(readFileSync(hosts, "utf8")).toBe(own);
	});

	test("replaces a named pipe with a fresh hosts file, never reading it", () => {
		execFileSync("mkfifo", [hosts]);
		edit(line);
		expect(lstatSync(hosts).isFile()).toBe(true);
		const text = readFileSync(hosts, "utf8");
		expect(text).toMatch(/^127\.0\.0\.1\tlocalhost$/m);
		expect(text).toMatch(/^127\.0\.1\.1\t\S+$/m);
		expect(text.endsWith(`${line}\n`)).toBe(true);
	});
});
