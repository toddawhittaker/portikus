# Answers to Portikus's questions about the Kitestring lab

**For:** Portikus's developers and their agents, as a reply to their questions on `portikus-lab-requirements.md` (snapshot: `kitestring-lab.md`).
**Date:** 2026-11-26.
**Answered by:** Todd and the lab's assistant.

This is a snapshot. The lab's requirements document is kept in the lab's repository and re-sent when it changes.

## 1. The job

Yes: build the **Required** items as a fix-batch epic and look into the **Check** items. Then write the section 4 reply.

- **Put the reply in a separate document in the Portikus repository.** The lab's requirements document will keep changing and the reply shouldn't get mixed into it.
- **Commit the requirements document too**, as `docs/deployments/kitestring-lab.md`. The master copy lives in the lab's repository as `docs/portikus-lab-requirements.md`; it is updated there and re-sent, so treat the Portikus copy as a snapshot.

## 2. Who builds the VM

**The lab builds the VM; Portikus is installed with `apt install portikus`.** The lab's assistant creates the VM on pve1 and records it in the lab's documentation.

## 3. Network facts

| Item | Answer |
|---|---|
| LAB VLAN | Exists: VLAN 30, 10.20.30.0/24, gateway and DNS 10.20.30.1. Full internet access; no access to the management or edge networks. |
| EDGE → LAB | The firewall already allows the EDGE VLAN to reach LAB on TCP 80 and 443. |
| `cloudflared` | The container exists at 10.20.20.10. The tunnel `kitestring-lab` is connected (2026-11-26), with routes for `portikus.kitestringlabs.org` and `*.kitestringlabs.dev`, the cache bypass on, and bot blocking off. |
| VM address | **10.20.30.30/24**, static. |
| Tailscale on the VM | **No.** The VM runs untrusted student code, so it stays off the tailnet. |
| SSH to the VM | Through pve1 as a jump host: `ssh -J root@pve1.kitestringlabs.org <user>@10.20.30.30`. |

## 4. Dates

The class is planned to start around the **end of February 2027**. There is no fixed date for a staging install.

## 5. Cloudflare Access and sign-in

- **Sign-in is LTI launches from the course system first, Portikus local accounts second.** No Entra ID.
- **No Cloudflare Access on either Portikus name.** Access would block LTI launches and the API-key clients.
- LTI launches arrive from the course system through Cloudflare's proxy and the tunnel. Check them under requirements section 2.4: the cross-site form POST, cookies inside the course system's frame, and the redirect back.

## 6. Credentials

- **Entra:** not used.
- **Cloudflare:** `kitestringlabs.org` and `kitestringlabs.dev` stay in one Cloudflare account for now; `kitestringlabs.dev` may move to its own account later. Portikus needs DNS edit on those two zones only (not `kitestringlabs.app`, which is for students' own apps). Todd creates the token at install time. Support a token per zone anyway, so the later move needs no code change.

## 7. Pilot versus production, and backups

- **Until the class starts, the lab VM is the staging install.** Install the epic's build there and measure WebSocket idle closes, the 100-second timeout, caching and LTI form posts through the real tunnel. From the class start it runs tested apt releases only.
- **Automated tests use a stand-in proxy** on Portikus's own rehearsal setup, not the real tunnel.
- **Backups of student data go to pve1's `tank` pool for now**, with no off-site copy, on a dedicated virtual disk attached to the VM. Say if Portikus needs something else, such as an NFS or SFTP target.
  - **Known limit:** the student-data disk is also on `tank`, so these backups protect against mistakes and VM loss, not against losing the pool or the host.

## 8. Access to pve1

- **Look, don't change.** No changes on pve1 (VMs, containers, storage, network or firewall settings, packages or files) except steps agreed with Todd beforehand.
- **Record anything that is changed** in the lab's repository, `docs/pve1-host.md` on pve1 at `~todd/projects/pve1`, or tell Todd.
- **The lab firewall, the switch and the Cloudflare account are off limits** the same way. Ask Todd for any change to tunnel routes or Cloudflare settings.
