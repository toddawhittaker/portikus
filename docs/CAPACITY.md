# Capacity: load test method and results

This note records how Portikus behaves with many students working at once, and what size the pilot VM needs. It serves SPEC.md section 25.2 (at least 25 concurrently active workspaces) and the latency targets in section 25.1. The brief is docs/EPIC-12B.md, task B4.

## Summary

- **Target:** 25 active workspaces (SPEC.md section 25.2).
- **Recommended pilot VM:** 8 vCPUs and 16 GiB of RAM, with the 100 GiB data disk grown to 200 GiB. The pilot today has 4 vCPUs and 8 GiB, which cannot hold 25.
- **Once workspaces are running, the target is met with a wide margin.** At 25 and at 40 workspaces, every steady-state latency was far inside its limit, and nothing failed.
- **Starting many workspaces at once is not met, and a bigger VM will not fix it.** The worker starts workspaces one at a time, about 4.5 seconds each. When 25 students open their workspaces within a minute, the last one waits over a minute (start p95 77 seconds against a 10 second target). This is a code limit in `apps/worker/src/reconcile.ts`, described under "Limits observed".

## Method

`make load-test TOFU_ENV=rehearsal-libvirt N=25` runs `infra/tests/load-test.sh`, which:

1. Refuses to start on the pilot, while Ansible is converging the VM, while a restore or rebuild is running against it, or when the VM lacks memory or thin-pool space for N workspaces (the capacity preflight).
2. Creates N student users directly in the database, each with a session. This is the same approach as the security suite. The users sit under their own issuer, `urn:portikus:loadtest`, so they can never collide with real accounts.
3. Copies the driver (`infra/tests/load/*.mjs`) to the VM and runs it there with the VM's own Node. The driver talks to the VM's Caddy on loopback, so every request goes through the real edge, and preview hosts never resolve to the pilot.
4. Deletes, on any exit, the users it recorded, the workspaces they own, and those workspaces' Incus instances and volumes. Nothing else is touched. `SWEEP=1` removes the leftovers of a run that was killed outright.

The driver has three phases:

- **Create.** It creates all N workspaces at the same moment, as a class does on its first day, and waits for each to finish provisioning.
- **Start.** It opens the workspaces spread evenly over 48 seconds, the way a browser does: a presence socket, then a terminal. A start is timed from opening the socket until a terminal can be made. That is SPEC.md's "ready for browser connection". Each simulated student then:
  - opens the terminal socket;
  - creates a project and opens its file-watch socket;
  - starts a stand-in coding agent (a process holding 150 MB resident) and a small web server;
  - gets a preview grant and a preview session.
- **Steady.** For 15 minutes, every 5 seconds, each student:
  - types into the terminal and times the echo;
  - writes a new file and times the file event on the watch socket;
  - reads Git status after that event;
  - loads its preview through the preview gateway.

  Each student also makes a recovery point every 5 minutes. The driver checks `/health` every 2 seconds.

It samples the VM every 15 seconds from `/proc` and the cgroup tree. That gives memory and CPU for each workspace, each control-plane service, and the whole VM. The thin-pool footprint is the pool's growth over the run.

What it does not simulate: a real coding agent's CPU and network use, dependency installs, builds, and inner Docker containers. Those vary by course and are covered by the headroom in the recommendation.

## Results

Rehearsal VM `portikus-rehearsal`, 12 vCPUs and 24 GiB, package `portikus 0.1.361+g5ef379c`, 2026-09-23. All times are in milliseconds unless stated.

| Measure (limit) | N=25, 15 min steady | N=40, 5 min steady |
|---|---|---|
| Start p95 (10 000) | **76 643, fails** | **131 418, fails** |
| Start p50 | 39 056 | 65 710 |
| Keystroke echo p95 (150) | 4 | 3 |
| File event p95 (1 000) | 166 | 161 |
| Git refresh p95 (2 000) | 16 | 14 |
| `/health` worst (2 000) | 23 | 4 |
| Preview request p95 | 6 | 5 |
| File save (PUT) p95 | 16 | 11 |
| Recovery point p95 | 71 | 28 |
| Failed operations (0) | 0 of about 18 600 | 0 of about 9 900 |
| Workspaces active | 25 of 25 | 40 of 40 |
| Provisioning, slowest | 34 s (5 at a time) | 281 s (40 at once) |
| VM memory in use at steady | 9.3 GiB | 13.4 GiB |
| VM CPU busy at steady | 8.8% of 12 vCPUs | 12.3% of 12 vCPUs |
| Highest 1-minute load | 6.8 (during starts) | 5.2 |
| Memory pressure | none | 0.12% at most |

The file event time includes the agent's deliberate 150 ms batching window (`FS_EVENT_BATCH_MS`).

The N=25 run created its workspaces five at a time. The N=40 run created all 40 at the same moment, and every one provisioned without error.

## Cost per workspace

Measured with the stand-in agent, steady activity:

- **Memory:** about 340 MiB that the VM cannot reclaim (8.4 GiB for 25, 12.2 GiB for 40). The workspace cgroup shows about 580 MiB, but part of that is page cache the kernel gives back under pressure. Of the 340 MiB, the stand-in accounts for 150.
- **CPU:** 0.03 of a core on average.
- **Disk:** 1.1 GiB of the thin pool for a new workspace that has been started once. Student files come on top.
- **Control plane:** Incus grows by about 700 MiB and the API by about 130 MiB at 25 workspaces. Caddy, PostgreSQL, the worker and the controller together stay under 300 MiB.

## The size the pilot needs

For 25 active workspaces:

- **Memory: 16 GiB.** The run used 9.3 GiB with a 150 MB stand-in. A real agent CLI, a dev server and an inner Docker container can double a workspace's memory. 16 GiB keeps about 6.5 GiB free for that. At 8 GiB, the pilot fills at about 19 stand-in workspaces, and sooner with real agents.
- **CPU: 8 vCPUs.** Steady use was about one core in total. The peak is a build: each workspace may use 2 cores (`limits.cpu`), so 8 vCPUs let three students build at full speed at the same time while the control plane stays responsive.
- **Data disk: 200 GiB.** At 1.1 GiB per started workspace, the 90 GiB thin pool on today's 100 GiB disk holds about 80 workspaces before any student data. SPEC.md section 25.2 targets 100 provisioned workspaces.

The rehearsal VM at 12 vCPUs and 24 GiB was measured directly. The 8 vCPU and 16 GiB figure is worked out from those measurements and has not been run. A confirming run is `make rehearsal-up REHEARSAL_VCPUS=8 REHEARSAL_MEMORY_MB=16384`, then `make load-test TOFU_ENV=rehearsal-libvirt N=25`, when nothing else is using the rehearsal VM.

Resizing the pilot is Todd's decision (docs/EPIC-12B.md, risk 9). CPU and memory are an OpenTofu change to `vcpus` and `memory_mb`, with a VM reboot. The data disk is less simple: OpenTofu can grow `data_disk_size_bytes`, but the `lvm` Ansible role only creates the thin pool and never extends it. Growing the pool on a disk that already holds student volumes needs its own automated step, which does not exist yet. Until it does, the 100 GiB disk is the limit, and 100 provisioned workspaces do not fit.

## Limits observed

1. **Starts and provisioning run one at a time.** In `apps/worker/src/reconcile.ts`, each sweep walks the workspaces to provision and then those to start with `for ... await`. The controller log shows one "instance started" about every 4.5 seconds, in strict sequence. So:
   - a student waits about 4.5 seconds for each start queued ahead of theirs, so the 10 second target holds only when at most one other start is waiting;
   - the worker can start at most about 13 workspaces a minute, whatever the VM's size;
   - the first-day creation of a class takes about 7 seconds per workspace (281 seconds for 40).

   The fix is a bounded number of starts and creates in parallel in the worker, which is code outside `infra/`. Once it lands, `make load-test` rechecks it.
2. **A controller restart during a create leaves the workspace in `error`.** On 2026-09-23 at 04:00:30, a `configure-vm` restarted `portikus-controller` while the worker was creating a workspace. The worker recorded `workspace.provision_failed` with `INCUS_UNAVAILABLE: Controller is unreachable`, and the instance was left created but stopped. It was not a concurrency failure: the two creates before it succeeded, and the 40-at-once run had none. The worker retries starts in `error`, but not creates, so an operator has to deal with such a workspace. Run `configure-vm` when no workspace is being created.
3. **Memory is the first resource limit.** Up to 40 workspaces on 24 GiB, no latency moved, and memory pressure barely registered. Memory ran out before CPU did.
