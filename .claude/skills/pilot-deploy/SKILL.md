---
name: pilot-deploy
description: Use only when Todd asks to deploy main or an epic head to the Portikus pilot VM; covers the build, database dump, package install, workspace image, and smoke test.
---

# Deploying to the pilot

Deploy only when Todd asks. The pilot is Todd's development VM with no
students on it: reading its database and making hand fixes there is
authorized, but still take a dump before anything destructive. Background
and rules: docs/OPERATIONS.md, "The pilot", "Rules that hold for every
pilot change", "Before a change: a database dump" and "Deploying".

Facts: the site is https://pilot.portikus.thewhittakers.org:8443, the VM
is 10.100.0.120, the SSH user is `deploy`, the database is
`sudo -u postgres psql -d portikus`, and Incus instances live in project
`portikus`.

## Steps

1. **Confirm the commit.** `git fetch origin`, then check
   `git rev-parse origin/<branch>` is the commit Todd means. Merges land on
   GitHub, so a local branch can be far behind.
2. **Build in a separate worktree** at that commit, never in the main
   checkout: `git worktree add <path> origin/<branch>`. In it, with the
   .nvmrc Node on PATH, run `corepack pnpm install --frozen-lockfile` and
   check `git rev-parse HEAD` equals `origin/<branch>`.
3. **Record the current version:**
   `ssh deploy@10.100.0.120 dpkg -s portikus | grep Version`.
4. **Dump the database first**, with the command in docs/OPERATIONS.md
   "Before a change: a database dump". Name it
   `portikus-pre-<label>-<date>.dump`, where the label names the change
   (for example `epic51`).
5. **Build the package:** `make build-deb` in the worktree.
6. **Install it:** `scp` the `.deb` to `deploy@10.100.0.120`, then on the
   VM `sudo apt-get install ./portikus_<version>_amd64.deb`. That reruns
   setup.
7. **Check setup:** `sudo portikus setup --follow` must end with
   `failed=0`. Check new migrations applied and every `portikus-*`
   service is active (`systemctl list-units 'portikus-*'`). API logs are
   `sudo journalctl -u portikus-api -o cat`.
8. **Workspace image, only when the image VERSION changed.** Build it on
   the pilot, make it the default, and keep the previous image as the
   rollback. Until the fix for issue #1601 is deployed, image cleanup can
   delete an image a workspace still uses: list each workspace's base
   image (`sudo incus list --project portikus`) first and protect those.
9. **Prepare the smoke test.** `make build-deb` prunes dev dependencies,
   which stops the mock LMS. Until the fix for issue #1576 is deployed,
   rerun `corepack pnpm install --frozen-lockfile` after the build.
10. **Run the smoke test** from the worktree. Until issue #1602 is fixed,
    pass the address by hand: `make smoke-test VM_IP=10.100.0.120
    PORTIKUS_PUBLIC_HOST=pilot.portikus.thewhittakers.org
    PORTIKUS_PUBLIC_PORT=8443`. A handful of skips is normal (checks that
    need setup the pilot lacks); name each skip in the report and treat
    any failure as real.
11. **Clean up.** Remove the build worktree once Todd is happy with the
    deploy.

## Report

Give Todd, in plain English:

- the version string before and after (it carries the commit);
- the setup result (`failed=0` or the failing step);
- migrations applied;
- workspace image versions: new default, rollback, any kept for a
  workspace;
- smoke counts (passed, failed, skipped) and what each skip was;
- the dump file name.
