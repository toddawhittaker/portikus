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
- **Data disk: 200 GiB.** The thin pool is 90% of the disk, and the nightly backup needs up to about 20 GiB of it (see "Backups in the thin pool" below). On today's 100 GiB disk that leaves about 70 GiB, or about 60 started workspaces at 1.1 GiB each before any student data. SPEC.md section 25.2 targets 100 provisioned workspaces. On a 200 GiB disk the pool is about 180 GiB: 110 GiB for 100 workspaces, 20 GiB for the backup, and about 50 GiB for student files.

The rehearsal VM at 12 vCPUs and 24 GiB was measured directly. The 8 vCPU and 16 GiB figure is worked out from those measurements and has not been run. A confirming run is `make rehearsal-up REHEARSAL_VCPUS=8 REHEARSAL_MEMORY_MB=16384`, then `make load-test TOFU_ENV=rehearsal-libvirt N=25`, when nothing else is using the rehearsal VM.

Resizing the pilot is Todd's decision (docs/EPIC-12B.md, risk 9). The steps are under "Resizing the pilot" below.

## Limits observed

1. **Starts and provisioning run one at a time.** In `apps/worker/src/reconcile.ts`, each sweep walks the workspaces to provision and then those to start with `for ... await`. The controller log shows one "instance started" about every 4.5 seconds, in strict sequence. So:
   - a student waits about 4.5 seconds for each start queued ahead of theirs, so the 10 second target holds only when at most one other start is waiting;
   - the worker can start at most about 13 workspaces a minute, whatever the VM's size;
   - the first-day creation of a class takes about 7 seconds per workspace (281 seconds for 40).

   The fix is a bounded number of starts and creates in parallel in the worker, which is code outside `infra/`. Once it lands, `make load-test` rechecks it.
2. **A controller restart during a create leaves the workspace in `error`.** On 2026-09-23 at 04:00:30, a `configure-vm` restarted `portikus-controller` while the worker was creating a workspace. The worker recorded `workspace.provision_failed` with `INCUS_UNAVAILABLE: Controller is unreachable`, and the instance was left created but stopped. It was not a concurrency failure: the two creates before it succeeded, and the 40-at-once run had none. The worker retries starts in `error`, but not creates, so an operator has to deal with such a workspace. Run `configure-vm` when no workspace is being created.
3. **Memory is the first resource limit.** Up to 40 workspaces on 24 GiB, no latency moved, and memory pressure barely registered. Memory ran out before CPU did. "When memory runs out" below says what protects the platform when it does.

## When memory runs out

Each workspace may use 4 GB (`workspace_memory_limit` in `infra/ansible/site.yml`), and the pilot has 8 GiB. So a few busy workspaces together can use up the VM's memory. The VM has no swap. When that happens, the Linux kernel's out-of-memory killer ends one process to free memory. It picks the process with the highest "OOM score", which is mostly its memory use plus an adjustment the service sets.

**What is in place.** PostgreSQL, portikus-api, portikus-worker, portikus-controller, portikus-dex and Caddy all start with `OOMScoreAdjust=-900`. That makes the kernel pick any workspace process before them. The Portikus units set it in `packaging/systemd`. Dex's unit is written by the `dex` role. PostgreSQL and Caddy get a systemd drop-in from their Ansible roles. Debian's PostgreSQL unit already sets -900; the drop-in keeps it if the packaging ever changes. PostgreSQL's worker processes stay at 0, as upstream recommends, so a runaway query can be killed without taking the server down. The security suite checks every one of these units on each run.

**Each protected service also has a memory cap.** A negative adjustment alone would be dangerous for a service that takes requests from the network. If a leak or a flood of requests made it grow, the kernel would kill every student's workspace before it. Dex is the clear case: its storage is in memory, and today every plain request to its sign-in page stores an auth request for ten minutes. So each service gets a systemd `MemoryMax`. When a service reaches its cap, the kernel kills that service alone, inside its own control group, and systemd restarts it after 5 seconds.

| Service | Measured on the rehearsal VM | `MemoryMax` |
|---|---|---|
| portikus-api | about 110 MiB idle, about 240 MiB at 25 workspaces | 1G |
| portikus-worker | about 100 MiB | 512M |
| portikus-controller | about 75 MiB | 512M |
| portikus-dex | about 30 MiB | 256M |
| portikus-mock-idp (test only) | a few tens of MiB | 256M |
| Caddy | about 80 MiB | 1G |
| PostgreSQL | about 25 MiB for the main process | none |

Each cap is at least four times the busiest measurement, so normal load never reaches it. The API and Caddy get the most room because they carry every student's traffic, including file uploads and downloads. PostgreSQL has no cap: its own settings (`shared_buffers`, `work_mem`, and the connection limit) bound it, only the API and the worker connect to it, and a cap would turn a busy moment into a database restart. Dex sign-in also needs a rate limit, which is separate work. The cap only makes sure a flood costs a Dex restart, which ends in-progress sign-ins, rather than the VM.

**What was not done, and why.**

- **No cap on all workspaces together (a `MemoryHigh` or `MemoryMax` on a shared parent).** Incus puts each container in its own top-level control group (`/sys/fs/cgroup/lxc.payload.<name>`), so there is no shared parent to set a limit on. Making one would mean overriding the control group paths Incus manages, which is fragile across Incus upgrades. Incus's own total, `limits.memory` on the project, is a different thing: it refuses to start a workspace once the per-workspace limits add up past the total. With 4 GB each that would allow only one workspace on the pilot. The per-workspace `limits.memory` stays the limit, and the OOM adjustment decides who goes when the VM as a whole runs out.
- **The Incus daemon is not protected.** A workspace's processes are started by Incus and inherit its adjustment, so protecting Incus would protect every workspace process too, which defeats the point.

**Rehearsal results, 2026-09-23.** Rehearsal VM, 12 vCPUs and 24 GiB. `PORTIKUS_SECURITY_HEAVY=1 make security-test TOFU_ENV=rehearsal-libvirt`, with no other workspace on the VM. The heavy test makes workspace `a` allocate 4 326 MiB, 512 MiB past its limit, while a loop asks `/health` and workspace `b`'s agent every half second.

| | Before (package 0.1.361+g5ef379c) | After (this change) |
|---|---|---|
| OOM adjustment, PostgreSQL | -900 (Debian's own) | -900 |
| OOM adjustment, API, worker, controller, Dex, Caddy | 0 | -900 |
| Kernel OOM score, PostgreSQL | 68 | 68 |
| Kernel OOM score, API, worker, controller, Dex, Caddy | 667 to 669 | 68 to 70 |
| Allocation past the limit in `a` | killed | killed |
| Kills counted in `a`'s own control group | 0, then 1 | 0, then 1 |
| PostgreSQL and API main processes | unchanged | unchanged |
| `/health` and `b`'s agent during the allocation | every sample within 2 s | every sample within 2 s |
| Suite result | 179 passed, 6 failed | 184 passed, 1 failed |

Before, the five platform services' adjustment checks failed, as expected. The one failure left in both runs is the `#408` marker. It reports `XPASS` because the rehearsal VM signs in through Dex, so the mock-provider gap it tracks is closed there.

With the caps in place, the security suite also checks that each service except PostgreSQL has a cap. The heavy tests start a throwaway service with Dex's settings (an adjustment of -900 and a 256M cap) that allocates 512 MiB. The kernel kills it at its cap, and systemd reports `oom-kill`.

What this shows: a workspace that allocates past its own limit is stopped inside its own control group, and nothing else notices, with or without the adjustment. The adjustment matters when the VM as a whole runs out, which happens when several workspaces each stay under 4 GB. There, the kernel ranks by OOM score, and the platform's scores dropped from about 668 to about 70, below any workspace process with real memory use. A VM-wide out-of-memory event was not forced on the shared rehearsal VM.

## Backups in the thin pool

The nightly backup (docs/adr/0024-backups-pulled-to-host.md) uses the same thin pool as the workspaces, `workspace-data`:

- **The staging volume, `portikus-backups`, 20 GiB.** Incus writes each export there as a file before the host pulls it. It holds one volume's export at a time, and the file is deleted afterwards. Incus mounts its volumes with `discard`, so the freed space goes back to the pool. At its peak, it can use the whole 20 GiB.
- **A snapshot and a thin copy of each volume being exported.** Both share the volume's blocks, so they cost almost nothing when made. They grow only by what the running workspace writes during that volume's export. Both are deleted before the next volume starts.
- **Thin pool metadata.** Each snapshot and copy adds a little. On the rehearsal VM the metadata was 12% used, so there is plenty of room.

So a backup needs up to about 20 GiB of free pool space, one volume at a time, plus what workspaces write while it runs. The sizing above keeps 20 GiB for it. The security suite and the load test both refuse to start when the pool is short of space. The pool growth in the `lvm` role does not change any of this: the backup volume lives inside the pool, and growing the pool gives it more room like everything else.

## Resizing the pilot

Two changes, done in a window Todd chooses: grow the data disk, and raise memory and vCPUs. Both have been planned against the rehearsal VM. Only the disk growth has been applied there. Take a backup first (`make backup`), and do both from a checkout that includes this change.

**Never run `make infra-apply` for the pilot from an older checkout after growing the disk.** Before this change, OpenTofu replaced the data disk when its size changed. An older checkout would plan to replace the grown disk with an empty 100 GiB one. Always read the plan before typing `yes`.

### Grow the data disk (no downtime)

1. In `infra/tofu/environments/dev-libvirt/terraform.tfvars`, set `data_disk_size_bytes = 214748364800` (200 GiB). The host needs no free space up front: the disk file is sparse and grows as it fills.
2. Run `make infra-plan`. The only change must be `module.platform_vm.terraform_data.data_disk_size` being created, or replaced if it already exists. If the plan shows the data disk or the VM being replaced, stop.
3. Run `make infra-apply`. It prints `grow-data-disk: grew portikus-data.qcow2 from 107374182400 to 214748364800 bytes`. The running VM sees the bigger disk at once.
4. Run `make configure-vm` with the pilot's usual settings. The `lvm` role grows the physical volume, then the thin pool's metadata and data, so the pool is again 90% of the disk.
5. Check: `ssh deploy@10.100.0.120 sudo lvs portikus-data/thinpool` shows about 180 GiB, and `incus storage info workspace-data` shows the same total.

OpenTofu refuses to shrink the disk, and the `lvm` role refuses to grow anything if the volume group sits on another device or holds anything but the thin pool. It never shrinks.

On the rehearsal VM, growing from 100 GiB to 150 GiB with `make rehearsal-up REHEARSAL_DATA_DISK_GB=150`, then `make configure-vm TOFU_ENV=rehearsal-libvirt`, gave:

| | Before | After |
|---|---|---|
| Disk seen by the VM | 100 GiB | 150 GiB, no reboot |
| Physical volume | 25 599 extents | 38 399 extents |
| Thin pool data | 89.8 GiB | 134.7 GiB |
| Thin pool metadata, and its spare | 92 MiB each | 136 MiB each |
| Left free in the volume group | 10 GiB | 15 GiB (10%) |
| Incus's total for the pool | 89.82 GiB | 134.73 GiB |

A second `configure-vm` changed nothing. The shrink refusal and both `lvm` refusals were tested on the rehearsal VM, and each left the disk and the volume group as they were.

### Raise memory and vCPUs (a restart of about two minutes)

1. Pick a time when no student is working, and take a backup.
2. In `terraform.tfvars`, set `memory_mb = 16384` and `vcpus = 8`. Check that the host has 16 GiB available: `free -m`.
3. Run `make infra-plan`. OpenTofu cannot resize a running VM, so the plan replaces `module.platform_vm.libvirt_domain.vm` with `memory` and `vcpu` marked as forcing it. Nothing else may be replaced, and the network interface's MAC address must stay the same. The Makefile passes the MAC address from the state, because the VM's network configuration and its DHCP address both match it. Without it, the new VM would come up with no network.
4. Shut the VM down cleanly, so that PostgreSQL and the thin pool are closed properly rather than cut off: `ssh deploy@10.100.0.120 sudo systemctl poweroff`, then wait until `virsh -c qemu:///system domstate portikus` says `shut off`.
5. Run `make infra-apply`. It creates the new VM on the same disks and waits for its address, which stays 10.100.0.120.
6. Run `make smoke-test`. The port forward from `make publish-vm` still points at the same address.

To undo it, set the old values and repeat steps 3 to 6.

This replacement has not been exercised: during this work the rehearsal VM was shared, and restarting it was not allowed. Rehearse it first with `make rehearsal-up REHEARSAL_VCPUS=8 REHEARSAL_MEMORY_MB=16384` (after shutting the rehearsal VM down cleanly, as in step 4). That run is also the confirming load test at 8 vCPUs and 16 GiB described under "The size the pilot needs".
