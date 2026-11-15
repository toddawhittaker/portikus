import {
	AdminAddress,
	AdminBackups,
	AdminCertificate,
	AdminEgressView,
	AdminImage,
	AdminLmsPlatforms,
	AdminProxyHosts,
	AdminSignin,
	BackupDumpFile,
	BackupKeptHome,
	BackupKeyStatus,
	BackupRestoreRequest,
	BackupSnapshotName,
	BackupSnapshotVolume,
	BackupStamp,
	CertificateJobDetail,
	CertificateJobId,
	DockerAdminResponse,
	DockerSettingsRequest,
	DockerUsageResponse,
	EgressBlockedSiteRequest,
	EgressDeleteQuery,
	EgressEntryRequest,
	EgressModeRequest,
	EgressPortsRequest,
	EgressPresetsRequest,
	ImageDiff,
	ImageDiffQuery,
	ImageJobDetail,
	ImageJobId,
	ImageJobRequest,
	LtiPlatformsUpdate,
	ProxyHostsUpdate,
	SeedImagesRequest,
	SeedJobsResponse,
} from "@portikus/contracts";
import { z } from "zod";
import { UuidParam } from "../../http.js";
import type { OperationRecords } from "../types.js";

const ImageJobParam = z.object({ id: ImageJobId });
const CertificateJobParam = z.object({ id: CertificateJobId });
const BackupSetParam = z.object({ stamp: BackupStamp });
const BackupDumpParam = z.object({ file: BackupDumpFile });
const BackupSnapshotParam = z.object({
	volume: BackupSnapshotVolume,
	snapshot: BackupSnapshotName,
});
const BackupKeptHomeParam = z.object({ volume: BackupKeptHome });

/** This family's operations, keyed by `"METHOD url"`. */
export const operations: OperationRecords = {
	"GET /admin/egress": {
		name: "egress.get",
		description:
			"Shows which sites workspaces may reach: the mode, the chosen presets and ports, the allowed and blocked sites, and the sites refused most often this week.",
		risk: "read",
		audience: "administrator",
		tool: true,
		input: {},
		output: AdminEgressView,
	},
	"PUT /admin/egress/mode": {
		name: "egress.set_mode",
		description:
			"Switches workspace internet access between open and allow-list only, and returns the updated egress settings.",
		risk: "change",
		audience: "administrator",
		tool: false,
		input: { body: EgressModeRequest },
		output: AdminEgressView,
	},
	"PUT /admin/egress/presets": {
		name: "egress.set_presets",
		description:
			"Chooses which ready-made groups of sites (such as package registries) workspaces may reach, and returns the updated egress settings.",
		risk: "change",
		audience: "administrator",
		tool: false,
		input: { body: EgressPresetsRequest },
		output: AdminEgressView,
	},
	"PUT /admin/egress/ports": {
		name: "egress.set_ports",
		description:
			"Sets the network ports workspaces may use to reach allowed sites, and returns the updated egress settings.",
		risk: "change",
		audience: "administrator",
		tool: false,
		input: { body: EgressPortsRequest },
		output: AdminEgressView,
	},
	"POST /admin/egress/entries": {
		name: "egress.add_entry",
		description:
			"Allows workspaces to reach one more host name or address range, and returns the updated egress settings.",
		risk: "change",
		audience: "administrator",
		tool: true,
		input: { body: EgressEntryRequest },
		output: AdminEgressView,
	},
	"PUT /admin/egress/entries/:id": {
		name: "egress.update_entry",
		description:
			"Changes one allowed host name or address range, and returns the updated egress settings.",
		risk: "change",
		audience: "administrator",
		tool: false,
		input: { params: UuidParam, body: EgressEntryRequest },
		output: AdminEgressView,
	},
	"DELETE /admin/egress/entries/:id": {
		name: "egress.remove_entry",
		description:
			"Stops allowing one host name or address range, and returns the updated egress settings.",
		risk: "change",
		audience: "administrator",
		tool: false,
		input: { params: UuidParam, query: EgressDeleteQuery },
		output: AdminEgressView,
	},
	"POST /admin/egress/blocked-sites": {
		name: "egress.add_blocked_site",
		description:
			"Blocks one site, and its subdomains, when internet access is open, and returns the updated egress settings.",
		risk: "change",
		audience: "administrator",
		tool: false,
		input: { body: EgressBlockedSiteRequest },
		output: AdminEgressView,
	},
	"PUT /admin/egress/blocked-sites/:id": {
		name: "egress.update_blocked_site",
		description:
			"Changes one blocked site or its label, and returns the updated egress settings.",
		risk: "change",
		audience: "administrator",
		tool: false,
		input: { params: UuidParam, body: EgressBlockedSiteRequest },
		output: AdminEgressView,
	},
	"DELETE /admin/egress/blocked-sites/:id": {
		name: "egress.remove_blocked_site",
		description: "Unblocks one site, and returns the updated egress settings.",
		risk: "change",
		audience: "administrator",
		tool: false,
		input: { params: UuidParam, query: EgressDeleteQuery },
		output: AdminEgressView,
	},
	"GET /admin/proxy-hosts": {
		name: "proxy_hosts.get",
		description:
			"Lists the extra host names the platform itself may reach through its proxy: the ones the operator set and the ones added here.",
		risk: "read",
		audience: "administrator",
		tool: false,
		input: {},
		output: AdminProxyHosts,
	},
	"PUT /admin/proxy-hosts": {
		name: "proxy_hosts.set",
		description:
			"Replaces the list of extra host names added here that the platform may reach, and starts the job that applies it.",
		risk: "change",
		audience: "administrator",
		tool: false,
		input: { body: ProxyHostsUpdate },
	},
	"GET /admin/lms": {
		name: "lms.get",
		description:
			"Lists the learning management systems registered for course sign-in, with the addresses to enter in the LMS to register this site.",
		risk: "read",
		audience: "administrator",
		tool: false,
		input: {},
		output: AdminLmsPlatforms,
	},
	"PUT /admin/lms": {
		name: "lms.set",
		description:
			"Replaces the list of learning management systems added here, and starts the job that applies it.",
		risk: "change",
		audience: "administrator",
		tool: false,
		input: { body: LtiPlatformsUpdate },
	},
	"GET /admin/signin": {
		name: "signin.get",
		description:
			"Shows how people sign in to this site (the provider and its non-secret settings), and the result of the latest sign-in test.",
		risk: "read",
		audience: "administrator",
		tool: false,
		input: {},
		output: AdminSignin,
	},
	"GET /admin/address": {
		name: "address.get",
		description:
			"Shows the web address this site is served at and its preview suffix, and the state of any address change.",
		risk: "read",
		audience: "administrator",
		tool: false,
		input: {},
		output: AdminAddress,
	},
	"GET /admin/certificate": {
		name: "certificate.get",
		description:
			"Shows how the site's security certificate is obtained, when it expires, and the state of any certificate job.",
		risk: "read",
		audience: "administrator",
		tool: false,
		input: {},
		output: AdminCertificate,
	},
	"GET /admin/certificate/jobs/:id": {
		name: "certificate.get_job",
		description:
			"Shows how one certificate job is going: its state and the last lines of its log.",
		risk: "read",
		audience: "administrator",
		tool: false,
		input: { params: CertificateJobParam },
		output: CertificateJobDetail,
	},
	"GET /admin/image": {
		name: "image.get",
		description:
			"Lists the workspace images on this server, which one is the default, newer versions available, coding agent versions, and free disk space.",
		risk: "read",
		audience: "administrator",
		tool: true,
		input: {},
		output: AdminImage,
	},
	"GET /admin/image/diff": {
		name: "image.diff",
		description:
			"Compares two workspace images and lists the tools and packages that were added, removed or changed.",
		risk: "read",
		audience: "administrator",
		tool: false,
		input: { query: ImageDiffQuery },
		output: ImageDiff,
	},
	"GET /admin/image/jobs/:id": {
		name: "image.get_job",
		description:
			"Shows how one workspace image job is going: its state and the last lines of its log.",
		risk: "read",
		audience: "administrator",
		tool: false,
		input: { params: ImageJobParam },
		output: ImageJobDetail,
	},
	"POST /admin/image/jobs": {
		name: "image.start_job",
		description:
			"Starts one workspace image job: fetch, build, make default, roll back, delete, or update or roll back the coding agents.",
		risk: "change",
		audience: "administrator",
		tool: false,
		input: { body: ImageJobRequest },
	},
	"GET /admin/docker": {
		name: "docker.get",
		description:
			"Shows the Docker pull cache for workspaces: its status, settings, whether a Docker Hub login is set, and the images in the seed.",
		risk: "read",
		audience: "administrator",
		tool: true,
		input: {},
		output: DockerAdminResponse,
	},
	"GET /admin/docker/seed/jobs": {
		name: "docker.list_seed_jobs",
		description: "Lists the most recent Docker seed rebuilds and how each one went.",
		risk: "read",
		audience: "administrator",
		tool: false,
		input: {},
		output: SeedJobsResponse,
	},
	"GET /admin/docker/usage": {
		name: "docker.usage",
		description:
			"Reports which Docker images workspaces pulled but the seed lacks, and which seed images nobody used, over the recent window.",
		risk: "read",
		audience: "administrator",
		tool: false,
		input: {},
		output: DockerUsageResponse,
	},
	"PUT /admin/docker/settings": {
		name: "docker.update_settings",
		description:
			"Changes whether the GitHub container registry is cached and the most space the seed may use; leave out a setting to keep it.",
		risk: "change",
		audience: "administrator",
		tool: false,
		input: { body: DockerSettingsRequest },
	},
	"POST /admin/docker/cache/clear": {
		name: "docker.clear_cache",
		description: "Asks for the Docker pull cache to be emptied.",
		risk: "change",
		audience: "administrator",
		tool: false,
		input: {},
	},
	"PUT /admin/docker/seed/images": {
		name: "docker.set_seed_images",
		description:
			"Replaces the list of images the next Docker seed rebuild will include.",
		risk: "change",
		audience: "administrator",
		tool: false,
		input: { body: SeedImagesRequest },
	},
	"POST /admin/docker/seed/jobs": {
		name: "docker.start_seed",
		description:
			"Starts a rebuild of the Docker seed from the saved image list and returns the new job.",
		risk: "change",
		audience: "administrator",
		tool: false,
		input: {},
	},
	"POST /admin/docker/seed/match": {
		name: "docker.match_seed",
		description:
			"Swaps the seed's Node and Python images for the ones matching the default workspace image, then starts a rebuild.",
		risk: "change",
		audience: "administrator",
		tool: false,
		input: {},
	},
	"GET /admin/backups": {
		name: "backups.list",
		description:
			"Lists the nightly backup sets, database dumps, snapshots and kept home folders, recent backup requests, and whether the host is reporting.",
		risk: "read",
		audience: "administrator",
		tool: true,
		input: {},
		output: AdminBackups,
	},
	"POST /admin/backups/run": {
		name: "backups.run",
		description: "Asks the host to take a backup now.",
		risk: "change",
		audience: "administrator",
		tool: true,
		input: {},
	},
	"POST /admin/backups/restores": {
		name: "backups.restore",
		description:
			"Restores one workspace's home folder from a backup set into a side copy, leaving the live home folder as it is.",
		risk: "change",
		audience: "administrator",
		tool: false,
		input: { body: BackupRestoreRequest },
	},
	"DELETE /admin/backups/sets/:stamp": {
		name: "backups.delete_set",
		description:
			"Permanently deletes one nightly backup set; the newest set cannot be deleted.",
		risk: "destructive",
		audience: "administrator",
		tool: false,
		input: { params: BackupSetParam },
	},
	"DELETE /admin/backups/dumps/:file": {
		name: "backups.delete_dump",
		description: "Permanently deletes one database dump file.",
		risk: "destructive",
		audience: "administrator",
		tool: false,
		input: { params: BackupDumpParam },
	},
	"DELETE /admin/backups/snapshots/:volume/:snapshot": {
		name: "backups.delete_snapshot",
		description: "Permanently deletes one workspace snapshot taken before a change.",
		risk: "destructive",
		audience: "administrator",
		tool: false,
		input: { params: BackupSnapshotParam },
	},
	"DELETE /admin/backups/kept-homes/:volume": {
		name: "backups.delete_kept_home",
		description:
			"Permanently deletes one kept home folder left behind by an earlier replacement.",
		risk: "destructive",
		audience: "administrator",
		tool: false,
		input: { params: BackupKeptHomeParam },
	},
	"POST /admin/backups/restores/:id/replace-home": {
		name: "backups.replace_home",
		description:
			"Replaces a workspace's live home folder with a finished restore copy, keeping the old folder aside.",
		risk: "destructive",
		audience: "administrator",
		tool: false,
		input: { params: UuidParam },
	},
	"GET /admin/backups/key": {
		name: "backups.key_status",
		description:
			"Shows whether a backup encryption key is installed, its public recipient, and whether it has been downloaded for safekeeping.",
		risk: "read",
		audience: "administrator",
		tool: false,
		input: {},
		output: BackupKeyStatus,
	},
};
