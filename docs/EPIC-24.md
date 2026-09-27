# Epic 24: Admin operations

This is the working brief for Epic 24. It is the requirement an agent implements against. Where it is silent, `docs/SPEC.md` wins on behaviour, `docs/STACK.md` on technology, and `docs/DESIGN.md` with `packages/ui` on look. Following docs/WORKFLOW.md, "Epic plans", this file lives only on the epic branch; the last task (T19) folds its lasting rules into SPEC.md, STATUS.md and the ADRs below, and deletes it. Code comments and tests cite SPEC.md sections or ADRs, never this file.

- **Base commit:** `c71130a` (main). **Epic branch:** `epic/24-admin-operations`. Builders reset to `origin/epic/24-admin-operations` and branch `task/24-<name>` from it.
- **Migration numbers, preassigned:** `0025_egress` (T3), `0026_backups` (T7), `0027_workspace_limits` (T11), `0028_throttle_hold` (T12), `0029_package_survey` (T14). No other task adds a migration.
- **ADR numbers, preassigned:** 0038 workspace egress allow-list (T4 drafts, T5 adds the infrastructure facts), 0039 the backup channel and the host-held key (T9), 0040 restoring one workspace and replacing a home (T8), 0041 HTTPS upstreams in the preview gateway (T16), 0042 the package survey (T14). Each is drafted as Proposed by its task; T19 marks them Accepted.

It closes issues #730, #626, #283 and #284, and three BACKLOG entries: "Re-provision after a failed create", "Per-workspace CPU, memory, and process limits", and "A limit on throttle-then-restart cycles". Task pull requests say `Fixes #N` where they finish an issue.

Terms used throughout:

- **Egress**: traffic a workspace starts toward the internet. **Open mode** is today's behaviour: everything but the private ranges. **Allow-list mode** lets a workspace reach only what an administrator listed.
- **DNS** (Domain Name System) turns a name such as `github.com` into an address. Each workspace asks the **bridge resolver**, the copy of **dnsmasq** (a small DNS and DHCP server) that Incus runs on the workspace network's gateway, `10.200.0.1`. **NXDOMAIN** is the DNS answer "no such name".
- **nftables** is the Linux firewall. A **set** is a list of addresses a rule can test in one step; an element added with a **timeout** leaves the set on its own. dnsmasq's **nftset** option adds every address it answers for a listed name to a set.
- **SNI** (Server Name Indication) is the host name a client writes, unencrypted, at the start of every HTTPS connection (the **client hello**). **Peek and splice** is Squid's mode that reads the SNI and then passes the connection through untouched, never decrypting it. **Intercept** means the firewall redirects a connection to Squid without the client knowing.
- **CIDR range**: an address range such as `203.0.113.0/24`.
- **The root helper**: a small program that runs as root, started by systemd when a request file appears, and accepts only a strictly checked request (the pattern of ADR 0030).
- **The host** is the Pop!_OS machine that runs the platform VM. **The host channel** is a host timer that asks the VM over SSH for backup requests, runs them, and writes the results back to the VM. **A set** is one backup run's directory under `/var/backups/portikus/<VM name>/<UTC timestamp>/` (ADR 0024).
- **Side copy**: a restored copy of a workspace's home placed in a new folder inside that same home, next to the live files.
- **Kept home**: the home volume a replace took out of service, kept as `ws-<24 hex>-home-replaced-<unix seconds>` until an administrator deletes it.
- **Throttle hold**: a CPU throttle (SPEC.md section 19.4) that a stop and start no longer lifts.

## What the user gets

- **Egress control.** An administrator switches the site between open and allow-list, turns on one-click presets (npm and Node.js, Python packages, Debian and the image's apt repositories, Docker Hub, GitHub, GitLab, Claude, Codex), keeps a labelled list of extra host names and address ranges, picks the allowed ports, tests whether a name would be allowed and why, and sees which names workspaces were refused most, for the whole site, with a one-click "Allow…". The policy takes effect for every running workspace within seconds, and survives a VM reboot.
- **Backups from the admin page.** A Backups tab shows recent sets (when, complete or not, size, workspaces covered), the next scheduled run, the last failure, and whether the host has reported lately. "Back up now" starts one. Old sets, old pre-change snapshots, old pre-change dumps and kept homes can be deleted. One workspace can be restored from a chosen set into a side copy in the student's home, and then, as a second confirmed step, the student's whole home can be replaced with it.
- **Re-provision.** A workspace stuck in `error` gets a **Re-provision** button in its detail panel.
- **Per-workspace limits.** A **Limits…** dialog sets one workspace's CPU count, memory and process ceiling; empty means the platform value from the Incus profile.
- **Throttle hold.** A workspace throttled three times within 24 hours (both settings) stays throttled through a restart until it goes quiet or an administrator lifts it; administrators are told once.
- **Packages students add.** The Health tab gains a "Packages students add" table of site-wide counts, with base-image candidates marked. After a rebuild, a student whose `sudo apt install` packages were lost sees them listed with a ready `sudo apt install …` line to copy.
- **HTTPS previews.** A student app that serves HTTPS on its port (for example `vite --https`) previews like any other. The browser still sees only the platform's certificate.

## Rulings

Rulings marked **(user)** came from Todd, **(orchestrator)** from the orchestrator, and **(brief)** were made in this brief after reading the code named beside them.

### All of the epic

1. **(user)** Every administrator action in this epic writes an audit row (SPEC.md section 24.11). The action names are listed under each part below. No audit row holds a secret, file contents, a command line, a workspace's network address, or a name a workspace looked up.
2. **(user)** The admin UI is built to the existing admin design (docs/DESIGN.md, `packages/ui`, SPEC.md section 20.1's frame rules: h2 per tab, h3 inside, compact density, sticky table headers, Save under its fields). There is no mockup; Todd reviews on the pilot.

### Egress (#284)

3. **(user)** Allow-list mode decides by **name**, never by URL (that would need decrypting traffic) and never by plain IP ranges for named services (CDN addresses are shared and rotate; ADR 0027 rejected that). Admin-entered CIDR ranges are the one address rule. **Open mode stays the default**, one policy per deployment, no per-user override. The existing private-range deny list (PR #424; the `workspace_egress_denied_ranges` in `infra/ansible/site.yml`, enforced by the Incus ACL and the firewall's forward chain) stays in both modes, unchanged.
4. **(user)** **The DNS half.** In allow-list mode the bridge resolver answers only listed names, where an entry covers itself and its subdomains (`github.com` covers `api.github.com`, never `evilgithub.com`), and answers NXDOMAIN otherwise. Every address it answers for a listed name goes into an nftables set with a timeout, through dnsmasq's `nftset`. The forward firewall lets workspace traffic out only to that set and to the admin's CIDR ranges, on the allowed ports. All other DNS (ports 53 and 853 to anything but the bridge resolver) is dropped.
5. **(user)** **The TLS-name half.** In allow-list mode, workspace HTTPS on port 443 is intercepted into Squid, which peeks at the client hello's SNI and splices (never decrypts) only when the name is listed, and refuses otherwise. So a hard-coded address shared by a CDN, which is in the set because a listed name uses it, still cannot reach a blocked name on it. Non-HTTPS protocols (Git over SSH and so on) fall under the DNS rule and the port rule.
6. **(brief)** **Plain HTTP on port 80 gets the same name check,** through a second Squid intercept port that reads the `Host` header. Without it, a hard-coded shared CDN address would reach any site on it over plain HTTP, which is the hole ruling 5 closes for HTTPS; Squid is already there, so it costs one more port and one more rule. The request is not cached or changed. SSH and other ports keep only the address check, and that residual risk is written down in ADR 0038.
7. **(brief)** **Where the rules live, and who changes them at runtime.** Verified against the pilot on 2026-09-27: Incus runs the bridge dnsmasq 2.91 (built with `nftset`) as the `incus` user with `CAP_NET_ADMIN`, under an AppArmor profile that allows `net_admin` and, through the `nameservice` abstraction, netlink; Incus lets us append dnsmasq options through the network key `raw.dnsmasq`. Incus network ACLs cannot reference a set that dnsmasq fills, and they apply every drop before every allow, so they cannot express this policy. Therefore:
   - **The DNS half is Incus configuration.** The workspace controller sets `raw.dnsmasq` on the `portikus-ws` network through its Incus provider, as it already sets instance configuration. It stays the only process that talks to Incus at runtime.
   - **The firewall half is a separate nftables table, `inet portikus_egress`, owned by a root helper.** Ansible's `/etc/nftables.conf` flushes only its own `inet filter` and `inet nat` tables, so it never touches this one. The helper, `portikus-egress-apply`, is package code run as root by a systemd path unit when the controller writes a request file (ADR 0030's pattern). It checks the request strictly, renders the table and Squid's name list, loads the table in one `nft -f` transaction, reloads the workspace Squid, and writes a status file. The controller runs with `NoNewPrivileges` and no network capabilities, and stays that way.
   - **Rejected:** giving the controller `CAP_NET_ADMIN` (the controller is already root-equivalent through the `incus-admin` group, so the gain in safety is small, but the helper also gives a boot-time apply ordered before Incus starts, and a Squid reload, which the controller cannot do); rendering Incus ACL rules from resolved addresses, as issue #284 first proposed (stale for CDNs, and ACLs cannot test a dynamic set); a separate dnsmasq of our own (more moving parts, kept as the fallback if T1 finds Incus's dnsmasq cannot write the set).
8. **(brief)** **The order of a change fails closed.** Open to allow-list: the helper's table first (with an empty set, workspaces briefly reach nothing), then `raw.dnsmasq`. Allow-list to open: the table first, then `raw.dnsmasq`. Removing a name flushes the name set, so an address learned for a removed name does not linger; clients re-resolve within seconds. At boot, `portikus-egress-apply.service` runs before `incus.service` and loads the last applied policy; if that is allow-list and loading fails, it loads a table that drops all forwarded workspace traffic. A request the helper refuses leaves the previous table in force.
9. **(brief)** **The table.** The helper renders, for allow-list mode (open mode renders the same sets with empty chains):
   ```
   table inet portikus_egress {
     set names_v4  { type ipv4_addr; flags timeout; timeout 6h; }   # filled by dnsmasq
     set ranges_v4 { type ipv4_addr; flags interval; }              # admin CIDR entries
     set ports     { type inet_service; }                           # allowed TCP ports
     chain prerouting { type nat hook prerouting priority dstnat - 1;
       iifname "portikus-ws" ip daddr @ranges_v4 return
       iifname "portikus-ws" ip daddr @names_v4 tcp dport 443 redirect to :3130
       iifname "portikus-ws" ip daddr @names_v4 tcp dport 80 redirect to :3129 }
     chain forward { type filter hook forward priority filter - 1;
       iifname "portikus-ws" meta l4proto { tcp, udp } th dport { 53, 853 } drop
       iifname "portikus-ws" ip daddr @ranges_v4 tcp dport @ports accept
       iifname "portikus-ws" ip daddr @names_v4 tcp dport @ports accept
       iifname "portikus-ws" drop }
   }
   ```
   An address not in either set is dropped before any redirect; a listed name's address reaches Squid only on 80 and 443; UDP (including QUIC, HTTP over UDP) and ICMP are dropped, so clients fall back to TCP. The existing `inet filter` forward chain still runs its private-range drops after this chain accepts. The workspace network has no IPv6 (`ipv6.address=none`), so the table is IPv4 only and allow-list mode drops any forwarded IPv6. The exact priorities, the `redirect` target address and any Incus ACL change it needs are T1's to confirm.
10. **(brief)** **dnsmasq's part**, rendered by the controller into `raw.dnsmasq` in allow-list mode (empty in open mode):
    ```
    server=/#/127.0.0.1#5399
    server=/github.com/#
    nftset=/github.com/4#inet#portikus_egress#names_v4
    … one server= and one nftset= line per listed name …
    ```
    `server=/name/#` sends a listed name to the normal upstream resolvers; the most specific `server=` wins, so every other name goes to `127.0.0.1:5399`, the blocked-name counter (ruling 13), which answers NXDOMAIN. Incus's own `.incus` names stay local. The set's six-hour timeout is refreshed by every answer; T1 checks that an answer from dnsmasq's cache refreshes it too, and if not, the controller adds `max-cache-ttl=300` so answers keep coming from upstream.
11. **(brief)** **A second Squid, from the `squid-openssl` package, for workspaces.** Debian's `squid` is built with GnuTLS and cannot peek at an SNI; `squid-openssl` can, and ships its binary as `/usr/sbin/squid-openssl`, beside `/usr/sbin/squid`, with no package conflict (checked on the pilot). So the API's proxy (ADR 0027) stays exactly as it is, and a separate instance, `portikus-workspace-proxy.service`, runs `squid-openssl` with its own configuration, PID file and logs. It listens only on the bridge gateway on 3129 (HTTP intercept) and 3130 (HTTPS intercept, `ssl_bump peek` then `splice` for listed names, `terminate` for everything else), refuses any destination in `workspace_egress_denied_ranges` or on the VM itself, caches nothing, and logs no client address. **One instance was rejected** because untrusted workspace traffic must not be able to slow or crash the proxy every SSO sign-in and LMS launch depends on, and because the two allow lists have different owners (Ansible for the API, the admin page for workspaces) and must never mix. The firewall's input chain accepts 3129 and 3130 from the bridge only for connections the redirect made (`ct status dnat`), so a workspace cannot use Squid as a forward proxy.
12. **(brief)** **The policy.** Stored in PostgreSQL (T3's migration): the mode, the enabled presets (by id), the allowed TCP ports (default 22, 80, 443; 1 to 65535; at most 20), and the entries. An entry is a host name (lower-case letters, digits, hyphens and dots, at most 253 characters, at least one dot, no wildcard, no URL, no IP address) or an IPv4 CIDR range that does not overlap any denied range, each with a label of at most 80 characters; at most 500 host entries and 100 ranges. **Presets are stored by id and expanded when the policy is applied,** so a Portikus release that corrects a preset's host list corrects every site. The preset lists live in `packages/contracts/src/egress.ts`:

    | Preset | Entries (each covers its subdomains) |
    |---|---|
    | npm and Node.js | `npmjs.org`, `yarnpkg.com`, `nodejs.org` |
    | Python packages | `pypi.org`, `pythonhosted.org` |
    | Debian and the image's apt repositories | `deb.debian.org`, `security.debian.org`, `download.docker.com`, `deb.nodesource.com`, `cli.github.com` |
    | Docker Hub | `docker.io`, `docker.com` |
    | GitHub | `github.com`, `githubusercontent.com`, `ghcr.io` |
    | GitLab | `gitlab.com` |
    | Claude (Anthropic) | `anthropic.com`, `claude.ai`, `claude.com` |
    | Codex (OpenAI) | `openai.com`, `chatgpt.com` |

    The rehearsal (T18) proves each preset with the real tool, and T4 corrects a list that proves short.
13. **(user, retention by brief)** **Blocked-lookup counts are site-wide aggregates, never tied to a student** (SPEC.md section 20.1). The worker runs a tiny DNS responder on `127.0.0.1:5399` (UDP and TCP) that answers every query NXDOMAIN and adds one to that name's count. It only ever hears from dnsmasq, so it never learns which workspace asked: the aggregate rule is structural, not a filter. Squid sends each refused SNI or `Host` to the same process on `127.0.0.1:5398` as a UDP log line holding only the name. Counts go to `egress_blocked_names` (day, name, source `dns` or `tls`, count), with no workspace, user or address column. **Retention: 30 days**, pruned daily; at most 2,000 distinct names a day, beyond which lookups count under `(other names)`, so a script that makes up names cannot fill the table. The Network tab shows the top 20 names over the last 7 days. dnsmasq's query log stays off, because it would record each workspace's address beside every name.
14. **(brief)** **"Test a host"** is one pure function in contracts, `explainHost(policy, input)`, used by the admin route, the tab, and T4's renderer tests, so the explanation and the enforcement cannot disagree. It answers allowed or not, and why: open mode; covered by preset P through entry E; covered by entry E ("label"); an address in range R; an address, which only a range or a lookup of a listed name can allow; not listed; or not a valid host name. It does no live lookup.
15. **(brief)** **What a student sees.** A refused name fails as "Could not resolve host", and a refused HTTPS connection as a reset; both are the tools' usual errors. A clearer message inside the terminal is left out.

### Backups (#730)

16. **(user)** **The VM never gets write access to the host.** The API records a request row; a host timer, which already reaches the VM over SSH, polls for requests, runs them with `backup.sh` or the restore scripts, and writes the status back to the VM. Every request kind and argument is checked on the host against a strict pattern before it reaches a command or a path, the way `backup.sh` already treats everything the VM says as hostile (ADR 0024).
17. **(brief)** **The channel.** `portikus-backup-channel.timer` fires every 30 seconds and runs `portikus-backup-channel.service` (root, oneshot) on the host. Each run: `ssh deploy@<VM> sudo portikus backup-channel pull` prints at most one claimed request as one JSON line; the host checks it, runs it, and sends `sudo portikus backup-channel report` a JSON document on standard input with the request's result and a fresh status (below). Anything that talks to the VM runs as the operator's account (`runuser -u <operator> -- ssh …`), so the VM trusts no new key, and sets stay owned by that account (ADR 0024). With no request, the run only reports status. A request left `claimed` for more than 15 minutes while the host reports no job running is marked failed ("interrupted").
18. **(brief)** **Request kinds**, each with the host's check:

    | Kind | Arguments | Host check and action |
    |---|---|---|
    | `backup` | none | refuses if a backup is running; runs `backup.sh --vm-name <state name> <VM>` as the operator |
    | `delete_set` | `stamp` | `^[0-9]{8}T[0-9]{6}Z$`, exists in this VM's directory, and is not the newest complete set; `rm -rf` of exactly that directory |
    | `delete_dump` | `file` | `^portikus-pre-[a-z0-9][a-z0-9-]{0,62}\.dump$` in this VM's `dumps/` directory; removes that file |
    | `restore_copy` | `stamp`, `instance`, `dir` | stamp as above; `^ws-[0-9a-f]{24}$`; the set holds `<instance>-home.age`; `dir` equals the name the host derives from the stamp (ruling 21); runs the side copy |
    | `import_home` | `stamp`, `instance` | as above; imports the volume as `<instance>-home-import` (ruling 22) |

    Any other kind, or any argument that fails its check, is reported failed with "refused by the host" and nothing runs. Deleting pre-change snapshots and kept homes is VM work, done by the worker through the controller, not by the host.
19. **(brief)** **The status the host writes back.** `vm` (the state name), `reportedAt`, `nextRunAt` (from the timer), `lastRun` (start, end, `success` or `failed`, from the nightly service or a requested run, whichever is newer), `lastFailure` (the newest failed run, if any, with a one-line reason), `running` (the request id, `nightly`, or none), `keyInstalled` (whether the restore key is in place), `sets` (newest 60: stamp, complete, size in bytes, the instance names whose volume files it holds, and the failed volume names from `FAILED`), and `dumps` (file, size, time). The instance names come from the set's file names, which are already plain text; no new plain-text file is added to a set, and no MANIFEST is decrypted for a status report. The VM checks the document with Zod, caps its size at 256 KiB, and stores it whole. The page says "The host has not reported since …" once it is more than 3 minutes old, and "Back up now" waits until it does.
20. **(user)** **The private age key is stored on the host, root-only,** at `/etc/portikus-backup/age-key.txt` (directory 0700, file 0600, root), installed by `make backup-install-key KEY=<path>`. ADR 0039 records the consequence Todd accepted: **whoever takes the host can read every backup.** ADR 0024's "the private half belongs offline" is superseded; Todd keeps his password-manager copy as the recovery copy. Only the channel's restore steps read the key, as root; the operator's account never gets it (no `LoadCredential`, no copy in its home).
21. **(user, path by brief)** **Restore one workspace into a side copy.** The administrator picks a set and one workspace it covers. The copy goes to `/home/student/restored-<YYYY-MM-DD>-<HHMM>` (the set's UTC time, for example `restored-2026-09-24-0230`). **Collisions:** if that folder exists the request fails with "~/restored-2026-09-24-0230 already exists. Rename or delete it, then try again." Nothing is merged or overwritten. **Quota:** the host sums the file sizes in the set's decrypted index and refuses when they exceed the home volume's free space less 5% ("There is not enough room in this workspace's home for the copy"); the copy counts against the student's home quota like any other files. **How:** the workspace must be running (the API answers 409 otherwise, "Start the workspace first"); while the job runs, the VM half holds a presence row so the grace period does not stop it, exactly as `restore.sh --start-check` does. The host decrypts `<instance>-home.age` as root and streams it to `incus exec --user 1000 --group 1000 --cwd /home/student <instance> -- tar -xz --strip-components=2 -C <dir> backup/volume`, so the files are written by the student's own account, owned by the student, and bound by the student's own permissions and quota; nothing is written as root inside the workspace. The student gets a notification: "An administrator restored a copy of your files from 24 September 2026, 02:30 into ~/restored-2026-09-24-0230." Audited `backup.restore_requested`, then `backup.restore_copied` or `backup.restore_failed`.
22. **(user, mechanism by brief)** **Replace home is a second, confirmed step,** offered only on a finished side copy, confirmed by typing the account's name (the existing `ConfirmByLabelDialog`). It is a new pending operation, `replace-home`, run by the worker like a rebuild (SPEC.md section 17.2, ADR 0021): if running, the worker makes a `before-replace-home` recovery point of each active project and stops the workspace; it then records an `import_home` request, and the host imports the set's home volume as `<instance>-home-import` with the backup's ID map (as `restore.sh` does); then the controller swaps volumes the way Reset Docker swaps Docker's: detach home, rename `<instance>-home` to the kept home `<instance>-home-replaced-<unix seconds>`, rename the import to `<instance>-home`, attach. Each step can be repeated, so a retry finishes a half-done swap. The workspace starts again if it was running. **The recovery point Todd asked for is two things:** the project recovery points, which the student can restore alone, and the kept home, which is the whole previous home untouched. The kept home is listed on the Backups tab until an administrator deletes it; putting it back is an operations runbook step, not a button. Audited `workspace.home_replace_requested`, then `workspace.home_replaced` or `workspace.home_replace_failed`. The student is notified.
23. **(brief)** **Pre-change snapshots and dumps.** Snapshots named `pre-<name>` on a workspace volume are listed through the controller and deleted one at a time; the controller refuses any other snapshot name, including the backup's own `portikus-backup`. Pre-change dumps move from the operator's home to `/var/backups/portikus/<VM name>/dumps/portikus-pre-<name>.dump`; T9 changes the runbook command in OPERATIONS.md, and the page lists and deletes only files there. Older dumps elsewhere are left for the operator.
24. **(user)** **Off-host weekly copy is left out.** It stays a manual step and a BACKLOG entry.

### Workspaces

25. **(brief)** **Re-provision** (`POST /admin/workspaces/:id/reprovision`) is allowed only from `error`, answers 409 otherwise, and sets the row back to `provisioning` with its error cleared, in one conditional update, audited `workspace.reprovision_requested`. The worker's create path then runs as for a new workspace; the controller's create already adopts an instance and volumes that exist (`provider.ts` `create`), so home data survives. A `POOL_FULL` refusal behaves as for any create.
26. **(brief)** **Per-workspace limits** are a nullable jsonb column, `workspaces.limits_config` (`cpu` 1 to 64, `memoryMiB` 512 to 262144, `processes` 500 to 32768; a missing key uses the profile), applied by a worker sync like `quota.ts` into `limits_applied`. The controller sets or removes `limits.cpu`, `limits.memory` and `limits.processes` on the instance (never the profile), which Incus applies live to a running container. The controller refuses more CPUs than the host has. Lowering memory below what the workspace uses makes the kernel stop its biggest process (SPEC.md section 19.3), and the dialog says so before Save. A change of `cpu` while throttled rewrites the throttle's allowance from its share in the same transaction, so the guard's per-tick comparison applies it. `processes` above 1,700 does not raise the terminals unit's own `TasksMax` (SPEC.md section 19.3); the dialog says so. The Incus usage route already reports each instance's own CPU limit; T2 confirms it reads the expanded configuration, so an override counts in the guard's averages. Audited `workspace.limits_updated` with the before and after values.
27. **(brief)** **Throttle hold.** Two new settings, `cpu_throttle_hold_after` (0 turns it off, 1 to 10, default 3) and `cpu_throttle_hold_hours` (1 to 168, default 24). The worker keeps each workspace's recent throttle times in `workspaces.cpu_throttle_recent` (trimmed to the window). When a throttle is the Nth within the window, the row's `cpu_throttle` gains `held: true`, audited `workspace.cpu_throttle_held`, and every enabled administrator gets one warning notification. A held throttle is not cleared when the worker records a stop; the worker passes the allowance with the start request, and the controller sets it before the instance runs instead of removing it, so there is no window at full speed. The automatic idle lift and an administrator's lift still work. The student's notice adds "It stays slowed after a restart because it was slowed {n} times in the last {hours} hours." The Health tab and the Workspaces table show **Held** beside **Throttled**.

### Package survey (#626)

28. **(user)** **Aggregate counts only**, never a per-student list (SPEC.md section 20.1). A per-student view needs Todd's ruling and a spec change.
29. **(brief)** **One recorded list per workspace, written by the image.** Rather than the worker reading `apt-mark showmanual` and `/var/log/apt/history.log*` through root inside each workspace, the image gains an apt hook (`DPkg::Post-Invoke`) that, after every apt run, writes the packages the student added (`apt-mark showmanual` minus the image's own list, which the build saves as `/usr/share/portikus/image-packages.txt`) to `~/.portikus/apt-packages.txt`, with a header naming the image version. The hook writes as the student (`runuser -u student`, temporary file then rename), so a symbolic link planted there gains nothing. That one file serves both the survey and the reinstall note, is current up to the moment of a rebuild, and needs nothing to run inside a workspace from outside. The history log is not read: the manual-install list already is "what the student asked for", and rotated logs miss older installs. A student can edit their own file; that changes only their own one count.
30. **(brief)** **The survey.** Once per UTC day for each workspace while it runs, the worker reads that file through the controller (`GET /instances/:name/added-packages`, the Incus file API, a regular file of at most 64 KiB, each line checked against Debian's package-name form) and adds one to each package's count for the day. Tables hold (day, package, workspaces) and (day, workspaces surveyed); the only per-workspace column is the date it was last surveyed. The table shows the latest day's counts ("added in 6 of 9 workspaces surveyed on 27 September"), with first and last seen, and marks a package as a base-image candidate when at least 2 workspaces and at least a third of those surveyed added it. Kept 90 days. Workspaces on an image without the hook are counted as "not surveyed".
31. **(brief)** **The reinstall note.** The workspace agent reads the file at start. When its image version differs from the running image and some listed packages are not installed now, `GET /packages/reinstall-note` returns them. The student sees a dismissible notice: "Packages you had installed with sudo apt were removed when your workspace was rebuilt: … Reinstall them with:" and a copyable `sudo apt install …` line. Dismiss rewrites the header to the current image, through the agent. Package names are checked against the same pattern before they are shown or put in the command line.

### HTTPS previews (#283)

32. **(brief)** **Detection: a TLS handshake from the agent, once per new listener.** Verified in `apps/workspace-agent/src/listening.ts`: the agent labels a port `http` only by a list of common port numbers and says it never probes student services. That changes: for each new student listener (not system, port 1024 or above, keyed by socket inode so it runs once per listener), the agent opens a TLS connection to it with certificate checks off and a one-second timeout, at most four at a time. A completed handshake sets `protocolHint: "https"`; anything else keeps today's label. A handshake is chosen over sending plain HTTP and reading the first byte because a TLS server's answer to a client hello is unambiguous, while its answer to plain text varies by server. The side effect is one "bad request" line in a plain HTTP server's own log. `https` is already in the contract.
33. **(user)** **Step 1, honest failure,** lands first and could ship alone: `/preview/authorize` answers 503 with a Portikus page for an `https` listener, "This port is speaking HTTPS; the preview expects plain HTTP. Start your server without TLS, or wait for HTTPS previews.", and the Preview tab shows the same text.
34. **(user)** **Step 2, support it.** The API adds a second trusted header, `X-Portikus-Upstream-Scheme: http` or `https`, from the registry beside `X-Portikus-Upstream`. Caddy copies it from `forward_auth`, strips any client-sent copy first (as it already strips a forged `X-Portikus-Upstream`), and uses a second `reverse_proxy` with a TLS transport and verification off for that hop only when it says `https`; the header rules of the existing proxy are shared, not copied. BROWSER-HANDLING.md section 16.3 still holds: the target comes only from the registry. The API's framing probe (`embeddable.ts`) speaks HTTPS to such a listener, with verification off, to the same registry target. WebSocket upgrades over the TLS transport are tested. With step 2 in place, the 503 page and the Preview tab text of step 1 are removed.

## Data model

**`0025_egress` (T3).**
- `settings`: `egress_mode text not null default 'open'` (`open` or `allow-list`), `egress_presets text[] not null default '{}'`, `egress_ports int[] not null default '{22,80,443}'`, `egress_version int not null default 0` (raised by every policy write), `egress_applied_version int`, `egress_applied_at timestamptz`, `egress_apply_error text`.
- `egress_entries`: `id uuid pk`, `kind text` (`host` or `range`), `value text unique`, `label text`, `created_by uuid null references users on delete set null`, `created_at`, `updated_at`.
- `egress_blocked_names`: `day date`, `name text`, `source text` (`dns` or `tls`), `count int`, primary key (day, name, source).

**`0026_backups` (T7).**
- `backup_requests`: `id uuid pk`, `kind text` (the five host kinds plus `delete_snapshot`, `delete_kept_home`), `args jsonb`, `state text` (`pending`, `claimed`, `done`, `failed`), `requested_by uuid null`, `requested_at`, `claimed_at`, `finished_at`, `error text`, `workspace_id uuid null` (for restores), `result jsonb`. A partial unique index allows one `pending` or `claimed` `backup` at a time.
- `backup_status`: one row, `host jsonb` (ruling 19), `host_reported_at`, `vm jsonb` (snapshots and kept homes, from the worker), `vm_listed_at`.
- `workspaces.pending_operation` accepts `replace-home`, with `pending_operation_args jsonb` holding the restore request id; the recovery trigger accepts `before-replace-home` (where those are constrained today).

**`0027_workspace_limits` (T11).** `workspaces.limits_config jsonb null`, `workspaces.limits_applied jsonb null`.

**`0028_throttle_hold` (T12).** `settings.cpu_throttle_hold_after int not null default 3`, `settings.cpu_throttle_hold_hours int not null default 24`, `workspaces.cpu_throttle_recent timestamptz[] not null default '{}'`. `cpu_throttle` jsonb gains an optional `held` key.

**`0029_package_survey` (T14).** `package_survey_days` (`day date pk`, `surveyed int`), `package_survey_counts` (`day date`, `package text`, `workspaces int`, primary key (day, package)), `workspaces.package_surveyed_on date null`.

## Interfaces

These are fixed here so tasks build against each other without waiting.

**Controller (T2 unless noted).** Every route keeps the controller's token check and name validation.
- `PUT /instances/:name/limits` `{cpu, memoryMiB, processes}`, each a number or null (null removes the instance key).
- `POST /instances/:name/start` accepts an optional `{cpuAllowance}` of the cpu-allowance route's form, set before start instead of removed.
- `GET /instances/:name/added-packages` → `{image, packages[]}`, or 404 `NOT_FOUND` when there is no such regular file.
- `GET /volumes/kept` → `{snapshots: [{volume, name, createdAt}], keptHomes: [{volume, instance, createdAt}]}`.
- `DELETE /volumes/:volume/snapshots/:snapshot`: only `pre-[a-z0-9][a-z0-9-]{0,62}` on a `ws-<24 hex>-(home|docker|recovery)` volume.
- `DELETE /volumes/:volume`: only `ws-<24 hex>-home-replaced-<digits>`, and only when nothing uses it.
- `POST /instances/:name/replace-home` → `{kept}`: stopped only, needs `<name>-home-import`, repeatable (ruling 22).
- Provider method `setNetworkDnsmasq(raw)` on the configured workspace network (new controller setting `INCUS_NETWORK`, default `portikus-ws`).
- **T4:** `PUT /egress-policy` `{version, mode, names[], ranges[], ports[]}` (presets already expanded), which writes the helper's request, waits up to 30 seconds for its status, then sets `raw.dnsmasq` in the order of ruling 8; `GET /egress-policy` → `{appliedVersion, appliedAt, error}`.

**The root helper (T4 code, T5 units).** Entry `/usr/lib/portikus/controller/dist/egress-apply-main.js`. Request `/var/lib/portikus/egress-request/request.json` (directory `root:portikus-controller` 0770); state in `/var/lib/portikus/egress-state/` (root-owned: `applied.json`, `status.json`, and Squid's `names.txt`, world-readable). Units: `portikus-egress-apply.path`, `portikus-egress-apply.service` (root oneshot, also `WantedBy=multi-user.target`, `After=nftables.service`, `Before=incus.service`).

**VM half of the backup channel (T8).** `portikus backup-channel pull` and `portikus backup-channel report`, subcommands of `packaging/bin/portikus`, root only, running `apps/worker/dist/backup-channel-main.js` as the `portikus` user with the worker's settings (as `reset-admin` does).

**API (all administrator-only, CSRF-checked, in `route-policy.ts` and the authorization matrix).**
- T3: `GET /admin/egress` (policy, entries, presets with their hosts, apply status, blocked top 20 for 7 days); `PUT /admin/egress/mode`; `PUT /admin/egress/presets`; `PUT /admin/egress/ports`; `POST /admin/egress/entries`; `PUT /admin/egress/entries/:id`; `DELETE /admin/egress/entries/:id`; `POST /admin/egress/test`. Every write carries the `egress_version` it was based on and answers 409 when stale. Audited `egress.mode_changed`, `egress.presets_changed`, `egress.ports_changed`, `egress.entry_added`, `egress.entry_updated`, `egress.entry_removed`; the worker audits `egress.applied` and `egress.apply_failed`.
- T7: `GET /admin/backups`; `POST /admin/backups/run`; `DELETE /admin/backups/sets/:stamp`; `DELETE /admin/backups/dumps/:file`; `POST /admin/backups/restores` `{stamp, workspaceId}`; `POST /admin/backups/restores/:id/replace-home`; `DELETE /admin/backups/snapshots/:volume/:snapshot`; `DELETE /admin/backups/kept-homes/:volume`. Each write answers 202 with the request, or 409. Audited `backup.requested`, `backup.set_delete_requested`, `backup.dump_delete_requested`, `backup.restore_requested`, `workspace.home_replace_requested`, `backup.snapshot_delete_requested`, `backup.kept_home_delete_requested`; the channel's report writes the outcome rows with actor `host`.
- T11: `PUT /admin/workspaces/:id/limits`; `POST /admin/workspaces/:id/reprovision`.
- T12: the two hold settings join `GET` and `PUT /admin/settings`.
- T14: `GET /admin/packages`; owner-only `GET /workspaces/:id/reinstall-note` and `POST /workspaces/:id/reinstall-note/dismiss`, passed to the agent's `GET /packages/reinstall-note` and `POST /packages/reinstall-note/dismiss`.

## The flows

1. **Switching to allow-list.** The administrator turns on presets, adds `api.example.edu`, and chooses Allow-list; the dialog says "Workspaces will reach only the 23 hosts and 0 ranges listed, on ports 22, 80 and 443. Connections to anything else stop now, including downloads in progress." The API raises `egress_version` and audits. Within a second the worker sees `egress_version` ahead of `egress_applied_version`, expands the presets and calls the controller. The controller writes the request; the helper loads the table and Squid's list and writes its status; the controller sets `raw.dnsmasq`; the worker records the applied version, and the tab shows "Applied just now".
2. **A workspace in allow-list mode.** `npm install` asks the bridge resolver for `registry.npmjs.org`; dnsmasq forwards it upstream and adds the answers to `names_v4`; the HTTPS connection is redirected to Squid, which reads SNI `registry.npmjs.org`, finds `npmjs.org`, and splices. `curl https://example.com` gets NXDOMAIN from the counter, which counts `example.com`. `curl --resolve example.com:443:<an npm CDN address> https://example.com` reaches Squid, which refuses the SNI.
3. **Back up now.** The API records a `backup` request. Within 30 seconds the host's poll claims it, runs `backup.sh`, and reports the new set and the result.
4. **Restore and replace.** The administrator opens a set, chooses "Restore a workspace…" and alice's workspace; the host checks the free space, streams the copy into `~/restored-2026-09-24-0230` as alice, and reports; alice is notified. Later the administrator chooses "Replace home…" on that copy and types "alice"; the worker makes recovery points and stops the workspace, the host imports the volume, the controller swaps it, and the workspace starts again with the old home kept.
5. **Throttle hold.** A workspace throttled at 10:00 and 13:00 is throttled again at 16:00; the third throttle is held, administrators get one notification, and the student's stop and start comes back throttled.
6. **Rebuild with added packages.** A student ran `sudo apt install python3-venv`; the hook wrote the file. An administrator rebuilds; on the next start the agent sees the image changed and `python3-venv` missing, and the student gets the reinstall notice.

## Security invariants to test

- **Egress.** In allow-list mode, from a workspace and from a Docker container inside it: an unlisted name gets NXDOMAIN; a listed name and its subdomain connect on 443, 80 and 22; a lookalike name does not; a hard-coded address of an unlisted site is dropped; a hard-coded address shared with a listed name is refused by Squid for a blocked SNI and a blocked `Host`; DNS to any outside resolver on 53 or 853, UDP 443, and DNS over HTTPS by name all fail; the private ranges stay denied; ports 3129 and 3130 cannot be reached without the redirect. In open mode, nothing changes from today (the existing security suite still passes).
- **Egress policy.** Writes are administrator-only, CSRF-checked and audited; a URL, wildcard, IP address as a host, or a range overlapping a denied range is refused; the helper refuses a malformed or oversized request and leaves the table unchanged; after a reboot in allow-list mode a failed apply leaves workspace forwarding dropped, not open.
- **Blocked names.** No table, log line or audit row pairs a looked-up name with a workspace, user or address; the counter listens on loopback only; a flood of made-up names stops at the daily cap; Squid's workspace log holds no client address.
- **Backup channel.** A lying VM (a request of an unknown kind, a stamp or file with `..`, `/` or a newline, a restore into an instance whose volume is not in the set, a delete of the newest complete set, an oversized or malformed document) makes the host refuse and run nothing; the host never passes a VM-sent string unquoted to a shell; the VM cannot read the key or any decrypted data except a copy into the named workspace; the key file is root-only and never copied.
- **Restore and replace.** A side copy is written by uid 1000 inside the workspace, never as root, and refuses an existing folder and a copy larger than the free space; replace refuses a running workspace and leaves the old home intact as a kept home; only `pre-*` snapshots and kept homes can be deleted through the controller.
- **Package survey.** No table holds both a workspace and a package name; the controller reads only a regular file of at most 64 KiB and ignores lines that are not package names; the hook writes as the student, so a symbolic link at the target overwrites nothing of root's.
- **HTTPS previews.** A client-sent `X-Portikus-Upstream-Scheme` never reaches the proxy; the TLS transport's target is only the registry's; certificate checks are off only on that hop; the agent's probe touches only the student's own listeners, once each.
- **Limits and re-provision.** Both are administrator-only and audited; re-provision refuses any state but `error`.

## Tasks for parallel builders

Each task owns only the files listed; ask the orchestrator before touching any other. Every task writes the unit tests for its own logic.

| Task | Agent | Files it owns | Depends on | Estimate |
|---|---|---|---|---|
| **T1 Egress spike** | infra | a throwaway rehearsal VM; the "Spike results" section appended to this file | none | 1 day |
| **T2 Controller routes** | builder | `apps/workspace-controller/src/**` except `src/egress/**`; `packages/contracts/src/controller.ts` and test; `apps/worker/src/controller-client.ts`, `fake-controller.ts` and tests | none | 2.5 days |
| **T3 Egress policy and admin API** | builder | `packages/db/src/migrations/0025_egress.ts`; `packages/contracts/src/egress.ts` (presets, validation, `explainHost`) and test; `apps/api/src/routes/admin-egress.ts` and test | none | 1.5 days |
| **T4 Egress enforcement code** | builder | `apps/workspace-controller/src/egress/**` (renderers, the helper's entry, the two routes); `apps/worker/src/egress.ts` (apply loop), `egress-blocked.ts` (the counter) and tests; `docs/adr/0038-*.md` | T1, T2, T3 | 3 days |
| **T5 Egress infrastructure** | infra | `infra/ansible/roles/workspace_egress/**` (new: `squid-openssl`, the workspace Squid unit and configuration, the helper's directories); `infra/ansible/roles/firewall/templates/nftables.conf.j2` (the `ct status dnat` input rule); `infra/ansible/roles/incus_network/**` only if T1 finds the ACL needs a change; `packaging/systemd/portikus-egress-apply.{path,service}` (new), `portikus-controller.service` (`ReadWritePaths`); `packaging/nfpm.yaml`; `infra/tests/security/workspace-egress.sh` (new); the egress section of `docs/OPERATIONS.md`; ADR 0038's infrastructure part | T1; T4 for the entry point's path only | 2 days |
| **T6 Network tab** | builder, then tester for e2e | `apps/web/src/admin/network/**` (new); `e2e/admin-egress.spec.ts`, `e2e/a11y-admin-egress.spec.ts` (new) | T3 | 2.5 days |
| **T7 Backup requests and admin API** | builder | `packages/db/src/migrations/0026_backups.ts`; `packages/contracts/src/backups.ts` and test; `apps/api/src/routes/admin-backups.ts` and test | none | 1.5 days |
| **T8 Backup channel, VM half, and replace home** | builder | `apps/worker/src/backup-channel-main.ts`, `backups.ts` (VM listing loop, snapshot and kept-home deletes, the `replace-home` operation) and tests; `apps/worker/src/reconcile.ts` (only the `replace-home` branch of step 3e); `packaging/bin/portikus` (the `backup-channel` subcommand); `docs/adr/0040-*.md` | T2, T7 | 2.5 days |
| **T9 Backup channel, host half** | infra | `infra/host/backup-channel.sh`, `restore-copy.sh` (new); `infra/host/systemd/portikus-backup-channel.{service,timer}` (new); `Makefile` (`backup-install-timer` installs the channel too; new `backup-install-key`); `infra/tests/backup-channel-test.sh` (new, a lying VM); `.github/workflows/ci.yml` (that test's step only); the Backups and Restore sections of `docs/OPERATIONS.md`, including the dumps path; `docs/adr/0039-*.md` | T7's JSON shapes (fixed above) | 2.5 days |
| **T10 Backups tab** | builder, then tester for e2e | `apps/web/src/admin/backups/**` (new); `e2e/admin-backups.spec.ts`, `e2e/a11y-admin-backups.spec.ts` (new), driving host reports through `backup-channel-main` with fixtures | T7, T8 | 2.5 days |
| **T11 Limits and re-provision** | builder, then tester for e2e | `packages/db/src/migrations/0027_workspace_limits.ts`; `packages/contracts/src/admin.ts` and test; `apps/api/src/routes/admin-workspaces.ts` and test; `apps/worker/src/limits.ts` and test; `apps/web/src/admin/WorkspaceDetail.tsx`, `LimitsDialog.tsx` (new) and tests; `e2e/admin-limits.spec.ts`, `e2e/admin-reprovision.spec.ts` (new) and axe checks in them | T2 | 2.5 days |
| **T12 Throttle hold** | builder, then tester for e2e | `packages/db/src/migrations/0028_throttle_hold.ts`; `packages/contracts/src/guard.ts`, `settings.ts` and tests; `apps/worker/src/guard.ts`, `apps/worker/src/reconcile.ts` (the stop-clears-throttle path and the start call only), `notifications.ts` and tests; `apps/api/src/routes/admin.ts` (settings), `workspace-view.ts` and tests; `apps/web/src/admin/SettingsTab.tsx`, `markers.tsx`, `apps/web/src/shell/ThrottleNotice.tsx` and tests; `e2e/guard-hold.spec.ts` (new) | T2 | 2 days |
| **T13 Apt hook in the image** | infra | `infra/workspace-image/portikus.yaml` (the image list, the hook, the version header) | none | 0.5 day |
| **T14 Package survey and reinstall note** | builder, then tester for e2e | `packages/db/src/migrations/0029_package_survey.ts`; `packages/contracts/src/packages.ts` (new) and test; `apps/worker/src/package-survey.ts` and test; `apps/api/src/routes/admin-packages.ts`, `reinstall-note.ts` (new) and tests; `apps/workspace-agent/src/packages-route.ts` (new), its registration in the agent's `server.ts`, and tests; `apps/api/src/fake-agent.ts` (the reinstall route); `apps/web/src/admin/health/PackagesSection.tsx` (new) and its line in `HealthTab.tsx`; `apps/web/src/shell/ReinstallNotice.tsx` (new) and its line in `WorkspacePage.tsx`; `e2e/package-survey.spec.ts`, `e2e/reinstall-note.spec.ts` (new) with axe; `docs/adr/0042-*.md` | T2, T13 (file format, fixed above) | 2.5 days |
| **T15 HTTPS previews, honest failure** | builder, then tester for e2e | `apps/workspace-agent/src/listening.ts` and test; `apps/api/src/routes/preview.ts`, `apps/api/src/preview/pages.ts` and tests; `apps/api/src/fake-agent.ts` (an HTTPS service); `apps/web/src/preview/**` (the text); `e2e/preview-https.spec.ts` (new) | none | 1.5 days |
| **T16 HTTPS previews, API side of TLS upstreams** | builder | `apps/api/src/routes/preview.ts`, `apps/api/src/preview/embeddable.ts`, `pages.ts` and tests; `apps/web/src/preview/**` (remove step 1's text); `e2e/preview-https.spec.ts`; `docs/adr/0041-*.md` | T15 | 1 day |
| **T17 HTTPS previews, Caddy TLS transport** | infra | `infra/ansible/roles/caddy/**`; `infra/tests/caddy-preview-test.sh` (TLS upstream, WebSocket over it, a forged scheme header) | T16's header name (fixed above) | 1 day |
| **T18 Rehearsal** | infra | a throwaway rehearsal VM; the "Rehearsal results" section of this file | T1 to T17 | 2 days |
| **T19 Fold** | builder | `docs/SPEC.md`, `docs/STACK.md`, `docs/STATUS.md`, `docs/BACKLOG.md`, `docs/OVERVIEW.md`, `docs/adr/0038` to `0042` (Accepted), `docs/adr/0024-*.md` (a superseded note), and deleting this file | T18 | 1 day |

**Shared files and their order.** Each task adds only its own lines to these; a task whose predecessor has not landed waits for it or rebases after it, and the merger hands a conflict to the orchestrator, who keeps both sides.

| File | Order |
|---|---|
| `packages/db/src/migrations/index.ts`, `schema.ts`, `db.test.ts` | T3, T7, T11, T12, T14 (migration order) |
| `packages/contracts/src/index.ts` | T2, T3, T7, T11, T12, T14 |
| `apps/api/src/server.ts`, `security/route-policy.ts`, `security/authz-matrix.test.ts` | T3, T7, T11, T12, T14 |
| `apps/workspace-controller/src/server.ts`, `provider.ts`, `fake-provider.ts` | T2, then T4 (one registration line and the egress routes' use of `setNetworkDnsmasq`) |
| `apps/worker/src/index.ts` (loop registration) | T4, T8, T11, T14 |
| `apps/worker/src/reconcile.ts` | T12 (stop and start), then T8 (the `replace-home` branch) |
| `apps/web/src/admin/AdminPage.tsx` and test (tabs **Network** and **Backups**, after Health and before Settings) | T6, then T10 |
| `apps/web/src/admin/health/HealthTab.tsx` | T12 (Held tag), then T14 (packages section) |
| `apps/api/src/fake-agent.ts`, `apps/api/src/routes/preview.ts`, `e2e/preview-https.spec.ts` | T15, then T14 (fake agent only), then T16 |
| `docs/OPERATIONS.md` | T5, then T9 |
| `infra/tests/security-test.sh`, `smoke-test.sh` | T5, T17, T9 |

UI tasks keep their queries inside their own folders and do not edit `apps/web/src/admin/queries.ts`.

**Parallel start.** T1, T2, T3, T7, T13 and T15 start together. T6 starts when T3 lands; T9 when T7 lands; T11 and T12 when T2 lands; T4 when T1, T2 and T3 have; T5 when T1 has; T8 when T2 and T7 have; T10 when T8 has; T14 when T2 and T13 have; T16 when T15 has, then T17. T18 and T19 are last. About 36 agent-days in all; with this order, about nine working days end to end.

**Reviews.** After T17 lands: **code-reviewer** over the epic head; **security-reviewer**, which must cover the egress enforcement (nftables table, dnsmasq rendering, the workspace Squid, the redirect and input rules), the root helper and its request checks, the host channel and the lying-VM tests, the host-held key, the side copy and the home swap, the apt hook writing in the student's home, the controller's new file read and deletes, the agent's TLS probe, and the TLS upstream; and **a11y-reviewer** over the Network and Backups tabs, the Limits dialog, Re-provision, the hold settings and tags, and the two student notices. Fixes land as further task pull requests, then each reviewer confirms. T18 runs after the fixes.

## Spike (T1)

On a throwaway rehearsal VM (`make rehearsal-up`), never the pilot, by hand, answer each with the command that proved it:

1. Does Incus's dnsmasq, under its AppArmor profile, add answers to a set in `inet portikus_egress` through `nftset=` given in `raw.dnsmasq`? Does an answer served from dnsmasq's cache refresh the element's timeout?
2. Does `server=/#/127.0.0.1#5399` with `server=/github.com/#` send `api.github.com` upstream and `example.com` to the counter, and do Incus's `.incus` names still resolve? Does setting `raw.dnsmasq` restart dnsmasq live, and for how long does DNS pause?
3. Does a redirect to the gateway on 3129 and 3130 pass the Incus ACL (whose first rule drops the whole bridge subnet), or does the ACL need the gateway carved out? Name the smallest change.
4. Does `squid-openssl` in intercept mode with `ssl_bump peek` and `splice` pass a listed SNI, refuse an unlisted one, splice to the original destination, and refuse a private destination? What certificate does `https_port … ssl-bump` insist on even when it never bumps?
5. Does traffic from a Docker container inside a workspace follow the same path?

If question 1 fails, the fallback of ruling 7 applies: our own dnsmasq on the bridge gateway, owned by T5, with Incus's DNS turned off for the network. The orchestrator rules on the results before T4 and T5 start.

## What done looks like, per task

Every task: `pnpm typecheck`, `pnpm lint` and `pnpm test` pass; coverage stays above the floors; any UI change ships Playwright tests and an axe check (SPEC.md section 25.8), run with `pnpm test:e2e` on a fresh test database.

- **T1:** the five answers with their commands, in this file.
- **T2:** fake-provider tests for each route, including every refusal (wrong volume or snapshot pattern, a running instance for replace, a symbolic link or oversized file for added packages, more CPUs than the host), a replace-home interrupted at each step and then finished by a retry, and start with an allowance; `incus.test.ts` cases for the network PATCH.
- **T3:** migration tests; `explainHost` and validation tests covering subdomains, lookalikes, IP addresses, URLs, wildcards, denied-range overlap and limits; route tests for each refusal, the stale-version 409 and each audit row.
- **T4:** renderer tests (table, Squid list, dnsmasq lines) for both modes, checked against `explainHost` on the same inputs; the helper refuses bad requests and writes the drop-all table on a failed boot apply; the controller route's ordering in both directions; the counter answers NXDOMAIN over UDP and TCP, counts, caps and prunes, and stores no address; the apply loop's retry and audit.
- **T5:** on a rehearsal VM, the security invariants for egress pass through `infra/tests/security/workspace-egress.sh`, in both modes, with `make security-test` and `make smoke-test` passing; `ansible-lint` passes; a reboot in allow-list mode comes back enforcing.
- **T6:** Playwright for switching mode (dialog, cancel, confirm, applied status), each preset, add, edit and remove with validation messages, ports, test a host (each explanation), and "Allow…" from the blocked list; axe on the tab and every dialog.
- **T7:** migration and route tests for every request, refusal (newest complete set, a stopped workspace for restore, a second running backup, a stale host) and audit row.
- **T8:** tests for pull (claims at most one, marks interrupted), report (Zod refusals, size cap, notifications, outcome audit rows), the listing loop, deletes, and the `replace-home` operation through the fake controller, including its recovery points.
- **T9:** `infra/tests/backup-channel-test.sh` feeds the host a lying VM (every refusal under the security invariants) and passes in CI; on the rehearsal VM, back up now, delete a set, delete a dump, a side copy and a replace all work through the channel; the key is root-only.
- **T10:** Playwright for the status card (fresh and stale host), sets, back up now, delete (and the newest set's refusal), restore, replace with its typed confirmation, snapshots, dumps and kept homes; axe on the tab and every dialog.
- **T11:** sync tests (applied live, retried, audited); route tests; Playwright for the Limits dialog and Re-provision from an error workspace; axe on both.
- **T12:** guard tests for the Nth throttle within the window and not outside it, a held throttle surviving a stop and start, idle and administrator lifts, and the single notification; Playwright for the settings, the Held tag and the student's text.
- **T13:** an image built on the rehearsal VM writes the file after `sudo apt install`, as the student, with the image version, and ignores a planted symbolic link.
- **T14:** survey tests (once per workspace per day, counts, candidate rule, pruning, no per-workspace package data); route tests; agent tests for the note; Playwright for the admin table and the student notice with its copy line; axe.
- **T15:** an agent test with a real TLS listener and a plain one; authorization matrix rows for the `https` hint; Playwright with the fake agent's HTTPS service showing the page and the tab text.
- **T16:** route tests for the scheme header both ways; the framing probe over HTTPS; Playwright previewing the fake agent's HTTPS service through Caddy, where the e2e setup runs Caddy.
- **T17:** `caddy-preview-test.sh` proves an HTTPS upstream, a WebSocket over it, and that a client-sent scheme header is ignored.
- **T18:** the rehearsal list below, with results recorded here.
- **T19:** SPEC.md sections 19.4, 20.1, 23.1, 24.9 and 24.11 and a new section 23.6 "Egress policy", STACK.md section 29 (runtime egress rules come from the database through the helper, not from a person), BROWSER-HANDLING.md section 11.1, STATUS.md, OVERVIEW.md, BACKLOG.md (the three entries removed; the off-host copy kept), ADRs accepted, this file deleted.

## Rehearsal (T18)

Build the package from the epic head, `make rehearsal-up`, `make configure-vm TOFU_ENV=rehearsal-libvirt`, `make build-workspace-image`, then:

- **Egress:** in open mode the smoke and security tests pass unchanged; switch to allow-list with every preset; from a workspace, `npm install`, `pip install`, `sudo apt-get update && sudo apt install`, `docker pull hello-world`, `git clone` over HTTPS and SSH, and the sign-in pages of `claude` and `codex` all work; everything in the egress invariants is refused; the blocked list shows the refused names with no address anywhere; reboot the VM and repeat one allowed and one refused check; switch back to open.
- **Backups:** install the channel and the key with the Make targets; back up now from the page; delete an old set; take a `pre-rehearsal` snapshot and dump by the runbook, see both listed, delete both; restore a workspace into a side copy and check files and Git heads against the set's index; replace its home and check the workspace starts with the restored files, the recovery points exist, and the kept home is listed; delete the kept home.
- **HTTPS previews:** `vite --https` and a plain server in one workspace; both preview, hot reload works over the TLS hop, and a forged scheme header from the browser changes nothing.
- **The rest:** a Limits change applies live (`limits.cpu` in Incus); re-provision after deleting an errored workspace's instance by hand; three throttles hold; `sudo apt install` then rebuild shows the reinstall note, and the next survey counts it.
- `make smoke-test` and `make security-test PORTIKUS_SECURITY_HEAVY=1` pass. Then `make rehearsal-destroy`.

## Risks

1. **Incus's dnsmasq may not be able to write the set,** or may treat `raw.dnsmasq` differently in a later Incus release. T1 proves it first; the fallback is our own dnsmasq. An Incus upgrade reruns T5's security checks.
2. **Allow-list mode can break a class mid-session.** A missing host stops a tool with an ordinary error. The presets are proved by T18, the blocked list shows what to add, "Test a host" explains, and open mode is one confirmed click away.
3. **Squid on the workspace path is a new failure point.** If it stops, HTTPS and HTTP from workspaces fail in allow-list mode (closed, not open). It runs under systemd with `Restart=on-failure`, and the smoke test checks it. Open mode does not use it.
4. **Shared CDN addresses on ports other than 80 and 443** (ruling 6) are still reachable by address. Few CDNs serve anything else; ADR 0038 says so.
5. **Encrypted client hello (ECH)** hides the real SNI behind a provider's public name, which Squid then refuses unless listed. Command-line tools rarely send it today; the blocked list would show the public name.
6. **The key on the host** opens every backup to whoever takes the host (ruling 20, accepted by Todd).
7. **A replace runs for minutes** with the workspace stopped; the student is told before and after, and the kept home makes it reversible by the runbook.
8. **Small counts can hint at a person** ("added in 1 of 1 workspaces"). The rule is aggregates; no names are shown, and Todd accepted aggregates in #626.

## Left out

- The automated weekly off-host copy of backups (BACKLOG).
- A per-student view of added packages, and admin-chosen packages for the image (Epic 15).
- A clearer in-terminal message when egress refuses a connection.
- Per-user or per-course egress policies, IPv6 egress, and an egress rule by port per host.
- Putting a kept home back from the page; restoring the database or several workspaces from the page (the runbook's `restore.sh` stays the disaster path).
- Backups on a site installed with `apt install portikus` on its own Debian host (Epic 15), which has no separate host to pull to; the tab says "Backups are not connected on this site".
- Editing the API's own egress list from the admin page (BACKLOG, "Admin pages for the egress allow list and LMS platforms").
