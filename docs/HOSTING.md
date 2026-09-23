# Renting a host for Portikus

Where to rent a machine that can run Portikus for a class of about 24
students, and what it costs. Prices were read on **2026-09-23** and change
often, so check the provider's own page before buying. The size comes
from docs/OPERATIONS.md, "Host hardware for a class of about 24".

## What the rented machine must be

A rented machine is the Portikus host itself, set up by the steps in
infra/README.md, "Bring your own Debian host". There is no libvirt VM
inside it. It must have:

- Debian 13 (trixie), 64-bit, with root access.
- An x86-64 (Intel or AMD) processor. The workspace image and most
  students' Docker images are built for it, so ARM machines are ruled
  out.
- A full virtual machine or a physical server. A container-based VPS
  (OpenVZ or LXC) cannot run Incus with nested Docker. Hardware
  virtualisation (KVM) is not needed.
- A second empty disk for the student storage pool. On a physical server
  it is usually named `/dev/nvme1n1`, so pass
  `-e data_disk_device=/dev/nvme1n1` to the playbook.
- A public IPv4 address, with inbound TCP 22 and 443 (or 8443).

A rented host with a real domain name can also use a public certificate
from Let's Encrypt instead of Caddy's private one, which removes the
risk of students clicking through certificate warnings.

## Prices for the recommended size

The recommended size is 12 to 16 dedicated threads and at least 24 GB of
memory. Prices are per month in US dollars, without VAT (customers in
the US pay none at Netcup, Hetzner or Contabo). Euro prices were
converted at about $1.17 to €1, the rate implied by Hetzner's own paired
price lists.

| Provider and plan | CPU | Memory | Disk | US site | $/month | Setup fee | Outbound traffic |
|---|---|---|---|---|---|---|---|
| OVH Eco SYS-3 (Xeon E-2288G) | 16 threads, physical server | 32 GB | 2 × 960 GB NVMe | Yes: Vint Hill VA, Hillsboro OR | $60 | $60 | Unmetered |
| OVH Eco SYS-GAME-2 (Ryzen 3800X) | 16 threads, physical server | 64 GB | 2 × 960 GB NVMe | Yes: Vint Hill VA | $66 | $66 | Unmetered |
| Hetzner EX44-1-LTD (i5-13500) | 20 threads, physical server | 64 GB | 2 × 512 GB NVMe | No: Germany, Finland | about $67, plus an IPv4 address | none | Unmetered |
| Hetzner AX42-1-LTD (Ryzen 8700GE) | 16 threads, physical server | 64 GB | 2 × NVMe | No | $77.30 | $39 | Unmetered |
| Contabo Cloud VDS L | 12 threads (6 cores) | 48 GB | 360 GB NVMe | Yes: St. Louis, New York, Seattle | $104.50, about $84 on a 24-month promotion | none | Unlimited at 750 Mbit/s |
| Netcup RS 4000 G12.5 | 12 dedicated cores, VM | 32 GB | 512 GB NVMe, plus block storage (250 GB ≈ €3) | Yes: Manassas VA | about $101 on a 12-month contract, including about €8 for the location | none | Flat rate, slowed above 3 TB a day |
| Oracle E5 Flex (x86) | 16 vCPU | 32 GB | Block storage, 250 GB ≈ $11 | Yes: Ashburn, Chicago | about $222 (worked out from list rates) | none | 10 TB free |
| Vultr Optimized Cloud 16c/32gb | 16 dedicated vCPU | 32 GB | 300 GB | Yes: Chicago | $320 | none | 8 TB included |
| Hetzner Cloud CCX43 | 16 dedicated vCPU | 64 GB | 360 GB | Yes: Ashburn, Hillsboro | $329.49 | none | US allowance not checked |
| DigitalOcean CPU-Optimized 16/32 | 16 dedicated vCPU | 32 GB | 200 GB | Yes: New York | $336 | none | 7 TB included |
| Linode Dedicated 16/32 | 16 dedicated vCPU | 32 GB | 640 GB | Yes: Chicago | $346 | none | 7 TB included |
| Scaleway POP2-HC-16C-32G | 16 dedicated vCPU | 32 GB | Block storage extra | No: Paris, Amsterdam, Warsaw | about $364 | none | Included |
| Google Cloud c3d-highcpu-16 | 16 vCPU | 32 GB | Persistent disk extra | Yes: Columbus OH, Iowa | $438, or $276 with a 1-year commitment | none | About $0.08–0.12 per GB |
| Azure D16als v6 | 16 vCPU | 32 GB | Managed disk extra | Yes | about $469 | none | About $0.087 per GB |
| AWS c7a.4xlarge | 16 vCPU | 32 GB | gp3 disk about $0.08 per GB | Yes: Ohio | about $599, or $397 with a 1-year Savings Plan | none | $0.09 per GB |

The OVH, Hetzner, Contabo, Netcup, DigitalOcean, Vultr, Linode, Scaleway
and Oracle figures come from the providers' own pages or public price
APIs. The Google, Azure and AWS figures come from third-party price
trackers (gcloud-compute.com and instances.vantage.sh). The US location
fee at Contabo, Hetzner's US traffic allowance and volume prices, and
the block-storage prices at DigitalOcean, Vultr and Linode were not
checked.

## Budget size (8 vCPU, 16 GB)

- Netcup RS 2000 G12.5: 8 dedicated cores, 16 GB, about $48 before the
  US location fee.
- OVH SYS-2: 16 slow Xeon-D threads, 32 GB, $49 plus $49 setup, in the
  US.
- Contabo VDS M: 8 threads, 32 GB, about $58 to $73.
- Vultr, Hetzner Cloud CCX33, DigitalOcean and Linode: $160 to $173.
- OVH VPS-4 costs $23.37 but has shared cores and slows to 10 Mbit/s
  after 3 TB of traffic. Not recommended.

## Off-host backups (50 to 200 GB)

- Backblaze B2, US-East region: about $6.95 per TB a month (a
  third-party figure). This is the simple US choice to pair with OVH,
  Netcup or Contabo.
- DigitalOcean Spaces or Linode Object Storage: about $5 for 250 GB (not
  checked).
- Oracle Object Storage: $0.0255 per GB a month.
- Hetzner Storage Box BX11: 1 TB for about €3.20 a month, in Germany and
  Finland only (a third-party figure).
- Netcup's block storage is on the same machine, so it is not off-host.

## Recommendation

**OVH Eco SYS-GAME-2 in Vint Hill, Virginia, at $66 a month, with
Backblaze B2 for off-host backups.** It matches the recommended size (16
threads, 64 GB), its second NVMe disk becomes the storage pool with
nothing extra to buy, traffic is unmetered, and it is in the US. The
catches: a one-time setup fee of one month, CPUs a few years old, stock
that changes daily, and minimal support. Whether OVH's installer offers
Debian 13 was not checked.

Other choices, and why not first:

- **Hetzner EX44 (about $67).** The best hardware for the price, but in
  Europe only. That adds about 100 ms of latency from Ohio and may raise
  questions under FERPA, the US law on student records. "LTD" prices
  last only while that hardware is in stock.
- **Netcup RS 4000 (about $101).** A US virtual machine with guaranteed
  cores, if a physical server is not wanted. Needs a 12-month contract.
- **Google Cloud c3d-highcpu-16 in Columbus, Ohio (about $276 with a
  1-year commitment).** The "boring big cloud" choice, at about four
  times OVH's price, with disk and outbound traffic billed on top.
  DigitalOcean ($336) and Linode ($346) are the simplest mid-size clouds
  with traffic included.
- **Oracle Ampere A1 (ARM, about $95 for 12 cores and 32 GB).** Ruled
  out: it is ARM (see "What the rented machine must be"). Oracle also
  cut its free allowance to 2 cores and 12 GB on 2026-06-15.

Hetzner raised cloud prices twice in 2026 (April and June 15), and its
dedicated-CPU cloud machines roughly doubled, so older blog posts
quoting Hetzner prices are wrong.
