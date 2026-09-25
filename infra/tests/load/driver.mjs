// The load test driver (docs/archive/epics/EPIC-12B.md, B4). It runs on the VM, reads its
// configuration as JSON on standard input (the session tokens are in it, so
// never on the command line), and writes the results as JSON to a file.
//
// Phases: provision N workspaces; start them within the ramp; hold steady
// activity; report. Cleanup belongs to load-test.sh, which recorded the users.
import fs from "node:fs";
import { Metrics, request, sleep } from "./http.mjs";
import { Student } from "./student.mjs";

const config = JSON.parse(fs.readFileSync(0, "utf8"));
const metrics = new Metrics();
const stopped = () => fs.existsSync(config.stopFile);
const log = (line) =>
	console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);

// SPEC.md section 25.1 and docs/archive/epics/EPIC-12B.md, in milliseconds.
const CRITERIA = [
	{ name: "start", stat: "p95", limit: 10000 },
	{ name: "echo", stat: "p95", limit: 150 },
	{ name: "file-event", stat: "p95", limit: 1000 },
	{ name: "git-refresh", stat: "p95", limit: 2000 },
	{ name: "health", stat: "max", limit: 2000 },
];

// ── Resource sampling, from /proc and the cgroup tree ───────────────

const SERVICES = {
	api: "system.slice/portikus-api.service",
	worker: "system.slice/portikus-worker.service",
	controller: "system.slice/portikus-controller.service",
	caddy: "system.slice/caddy.service",
	postgres: "system.slice/system-postgresql.slice",
	incus: "system.slice/incus.service",
};

const readText = (path) => {
	try {
		return fs.readFileSync(path, "utf8");
	} catch {
		return null;
	}
};
const field = (text, name) => {
	const match = text?.match(new RegExp(`^${name}\\s+(\\d+)`, "m"));
	return match ? Number(match[1]) : null;
};

function cgroupSample(dir) {
	const base = `/sys/fs/cgroup/${dir}`;
	const current = readText(`${base}/memory.current`);
	if (current === null) return null;
	return {
		memory: Number(current),
		anon: field(readText(`${base}/memory.stat`), "anon"),
		cpuUsec: field(readText(`${base}/cpu.stat`), "usage_usec"),
	};
}

function sample(students) {
	const meminfo = readText("/proc/meminfo");
	const cpu = readText("/proc/stat")
		.split("\n")[0]
		.trim()
		.split(/\s+/)
		.slice(1)
		.map(Number);
	const pressure = (kind) =>
		Number(readText(`/proc/pressure/${kind}`)?.match(/some avg10=([\d.]+)/)?.[1] ?? 0);
	const workspaces = {};
	for (const student of students) {
		if (student.instance)
			workspaces[student.key] = cgroupSample(
				`lxc.payload.portikus_${student.instance}`,
			);
	}
	const services = {};
	for (const [name, dir] of Object.entries(SERVICES))
		services[name] = cgroupSample(dir);
	return {
		at: Date.now(),
		memAvailableKib: field(meminfo, "MemAvailable:"),
		memTotalKib: field(meminfo, "MemTotal:"),
		cpuBusy: cpu[0] + cpu[1] + cpu[2] + cpu[5] + cpu[6] + cpu[7],
		cpuTotal: cpu.reduce((a, b) => a + b, 0),
		load1: Number(readText("/proc/loadavg").split(" ")[0]),
		cpuPressure: pressure("cpu"),
		memoryPressure: pressure("memory"),
		workspaces,
		services,
	};
}

// ── The run ─────────────────────────────────────────────────────────

async function main() {
	const students = config.students.map(
		(s) =>
			new Student({
				key: s.key,
				token: s.token,
				api: config.api,
				metrics,
				previewPort: config.previewPort,
			}),
	);
	const samples = [];
	const phases = {};

	// All at once, as a class does on its first day.
	log(`Creating ${students.length} workspaces at the same moment...`);
	phases.provisionStart = Date.now();
	await Promise.all(
		students.map(async (student) => {
			try {
				await student.provision();
			} catch (error) {
				student.dead = true;
				metrics.fail("provision", `${student.key} ${error.message}`);
			}
		}),
	);
	const live = () => students.filter((s) => !s.dead);
	log(`Provisioned ${live().length} of ${students.length}.`);
	samples.push({ phase: "idle", ...sample(students) });

	// /health every two seconds from here to the end.
	let healthOn = true;
	const health = (async () => {
		while (healthOn) {
			try {
				const res = await request(`${config.api}/health`, { timeoutMs: 10000 });
				if (res.status === 200) metrics.record("health", res.ms);
				else metrics.fail("health", `status ${res.status}`);
			} catch (error) {
				metrics.fail("health", error.message);
			}
			await sleep(2000);
		}
	})();
	let phase = "ramp";
	const sampler = setInterval(
		() => samples.push({ phase, ...sample(students) }),
		config.sampleSeconds * 1000,
	);

	log(`Starting ${live().length} workspaces over ${config.rampSeconds} s...`);
	phases.rampStart = Date.now();
	const gap = (config.rampSeconds * 1000) / Math.max(1, live().length);
	await Promise.all(
		live().map(async (student, index) => {
			await sleep(index * gap);
			if (stopped()) return;
			try {
				await student.start();
			} catch (error) {
				student.dead = true;
				metrics.fail("start", `${student.key} ${error.message}`);
				return;
			}
			try {
				await student.setUp();
			} catch (error) {
				student.dead = true;
				metrics.fail("setup", `${student.key} ${error.message}`);
			}
		}),
	);
	log(`${live().length} of ${students.length} are running and set up.`);

	phase = "steady";
	phases.steadyStart = Date.now();
	const end = phases.steadyStart + config.steadySeconds * 1000;
	samples.push({ phase, ...sample(students) });
	log(
		`Holding steady activity for ${config.steadySeconds} s, every ${config.tickSeconds} s per workspace...`,
	);
	const progress = setInterval(() => {
		const echo = metrics.summary("echo");
		log(
			`  ${Math.round((Date.now() - phases.steadyStart) / 1000)} s: echo p95 ${Math.round(echo.p95 ?? 0)} ms, failures ${[...metrics.failures.values()].reduce((a, b) => a + b, 0)}`,
		);
	}, 60000);
	await Promise.all(
		live().map(async (student) => {
			const tick = config.tickSeconds * 1000;
			let nextPoint = Date.now() + Math.random() * config.recoverySeconds * 1000;
			await sleep(Math.random() * tick);
			while (Date.now() < end && !stopped()) {
				const began = Date.now();
				await student.act();
				if (Date.now() >= nextPoint) {
					await student.recoveryPoint();
					nextPoint += config.recoverySeconds * 1000;
				}
				await sleep(Math.max(0, tick - (Date.now() - began)));
			}
		}),
	);
	clearInterval(progress);
	phases.steadyEnd = Date.now();
	samples.push({ phase, ...sample(students) });
	clearInterval(sampler);
	healthOn = false;
	await health;
	for (const student of students) student.close();

	const result = report(students, samples, phases);
	fs.writeFileSync(config.resultFile, JSON.stringify(result, null, 2));
	process.exit(stopped() ? 2 : result.passed ? 0 : 1);
}

// ── The report ──────────────────────────────────────────────────────

const mib = (bytes) => Math.round(bytes / 1048576);
const round = (n) => (n === null || n === undefined ? "-" : Math.round(n));

function footprint(steady, key, pick) {
	const values = steady
		.map((s) => s.workspaces[key])
		.filter(Boolean)
		.map(pick);
	return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function report(students, samples, phases) {
	const steady = samples.filter((s) => s.phase === "steady");
	const first = steady[0];
	const last = steady[steady.length - 1];
	const idle = samples.find((s) => s.phase === "idle");
	const seconds = (last.at - first.at) / 1000 || 1;

	const perWorkspace = students
		.filter((s) => !s.dead && first.workspaces[s.key] && last.workspaces[s.key])
		.map((s) => ({
			key: s.key,
			memoryMib: mib(footprint(steady, s.key, (w) => w.memory)),
			anonMib: mib(footprint(steady, s.key, (w) => w.anon)),
			cpuCores:
				(last.workspaces[s.key].cpuUsec - first.workspaces[s.key].cpuUsec) /
				1e6 /
				seconds,
		}));
	const mean = (list, pick) =>
		list.length ? list.reduce((a, b) => a + pick(b), 0) / list.length : null;
	const services = Object.fromEntries(
		Object.keys(SERVICES).map((name) => {
			const a = first.services[name];
			const b = last.services[name];
			return [
				name,
				a && b
					? {
							memoryMib: mib(b.memory),
							cpuCores: (b.cpuUsec - a.cpuUsec) / 1e6 / seconds,
						}
					: null,
			];
		}),
	);
	const minAvailable = Math.min(...samples.map((s) => s.memAvailableKib));
	const cpuBusy = (last.cpuBusy - first.cpuBusy) / (last.cpuTotal - first.cpuTotal);

	const latency = Object.fromEntries(
		metrics.names().map((name) => [name, metrics.summary(name)]),
	);
	const totalFailures = [...metrics.failures.values()].reduce((a, b) => a + b, 0);
	const checks = CRITERIA.map((c) => {
		const value = latency[c.name]?.[c.stat] ?? null;
		return { ...c, value, ok: value !== null && value <= c.limit };
	});
	checks.push({
		name: "failed operations",
		stat: "count",
		limit: 0,
		value: totalFailures,
		ok: totalFailures === 0,
	});
	checks.push({
		name: "workspaces active",
		stat: "count",
		limit: students.length,
		value: students.filter((s) => !s.dead).length,
		ok: students.every((s) => !s.dead),
	});
	const vm = {
		memTotalMib: Math.round(first.memTotalKib / 1024),
		memAvailableIdleMib: Math.round(idle.memAvailableKib / 1024),
		memAvailableMinMib: Math.round(minAvailable / 1024),
		memUsedByRunMib: Math.round((idle.memAvailableKib - minAvailable) / 1024),
		cpuBusyPercent: Math.round(cpuBusy * 1000) / 10,
		load1Max: Math.max(...samples.map((s) => s.load1)),
		cpuPressureMax: Math.max(...samples.map((s) => s.cpuPressure)),
		memoryPressureMax: Math.max(...samples.map((s) => s.memoryPressure)),
	};
	const result = {
		passed: checks.every((c) => c.ok),
		n: students.length,
		config: { ...config, students: undefined },
		phases,
		checks,
		latency,
		footprint: {
			memoryMibMean: round(mean(perWorkspace, (w) => w.memoryMib)),
			memoryMibMax: Math.max(...perWorkspace.map((w) => w.memoryMib)),
			anonMibMean: round(mean(perWorkspace, (w) => w.anonMib)),
			cpuCoresMean:
				Math.round((mean(perWorkspace, (w) => w.cpuCores) ?? 0) * 1000) / 1000,
			perWorkspace,
		},
		services,
		vm,
		errors: metrics.errors,
		samples,
	};

	console.log("");
	console.log(
		`--- Load test, N=${students.length}, steady ${Math.round(seconds)} s ---`,
	);
	console.log(
		"Operation                      count  fail    p50    p95    p99    max  (ms)",
	);
	for (const [name, s] of Object.entries(latency)) {
		console.log(
			`${name.padEnd(30)} ${String(s.count).padStart(5)} ${String(s.failed).padStart(5)} ${[s.p50, s.p95, s.p99, s.max].map((v) => String(round(v)).padStart(6)).join(" ")}`,
		);
	}
	console.log("");
	console.log(
		`Per workspace: memory ${result.footprint.memoryMibMean} MiB mean (${result.footprint.memoryMibMax} max), anonymous ${result.footprint.anonMibMean} MiB, CPU ${result.footprint.cpuCoresMean} cores`,
	);
	for (const [name, s] of Object.entries(services)) {
		if (s)
			console.log(
				`Service ${name}: memory ${s.memoryMib} MiB, CPU ${Math.round(s.cpuCores * 1000) / 1000} cores`,
			);
	}
	console.log(
		`VM: ${vm.memTotalMib} MiB, available ${vm.memAvailableIdleMib} MiB before the start and ${vm.memAvailableMinMib} MiB at the lowest; CPU busy ${vm.cpuBusyPercent}% in the steady phase; load max ${vm.load1Max}; pressure max cpu ${vm.cpuPressureMax}% memory ${vm.memoryPressureMax}%`,
	);
	console.log("");
	for (const c of checks) {
		console.log(
			`${c.ok ? "PASS" : "FAIL"}  ${c.name} ${c.stat} ${round(c.value)} (limit ${c.limit})`,
		);
	}
	if (metrics.errors.length) {
		console.log("");
		console.log("First failures:");
		for (const line of metrics.errors.slice(0, 20)) console.log(`  ${line}`);
	}
	return result;
}

main().catch((error) => {
	console.error(`driver: ${error.stack ?? error.message}`);
	process.exit(3);
});
