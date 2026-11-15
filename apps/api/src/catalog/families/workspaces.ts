import {
	AdminProcessSnapshot,
	AdminWorkspaceDetail,
	AdminWorkspaceList,
	AgentLogResponse,
	ProcessStopRequest,
	ProcessStopResponse,
	RebuildWorkspaceRequest,
	UpdateGuardRequest,
	UpdateLimitsRequest,
	UpdateQuotaRequest,
	Workspace,
} from "@portikus/contracts";
import { z } from "zod";
import { UuidParam } from "../../http.js";
import type { OperationRecords } from "../types.js";

/** The workspace id and process id of a process stop; the handler checks the process id by hand as digits. */
const ProcessStopParams = z.object({
	id: UuidParam.shape.id,
	pid: z.string().regex(/^[1-9]\d{0,9}$/),
});

/** This family's operations, keyed by `"METHOD url"`. */
export const operations: OperationRecords = {
	"GET /admin/workspaces": {
		name: "workspaces.list",
		description: "Lists every student workspace with its owner, state, and settings.",
		risk: "read",
		audience: "administrator",
		tool: true,
		input: {},
		output: AdminWorkspaceList,
	},
	"GET /workspaces/:id": {
		name: "workspaces.get",
		description:
			"Returns one workspace's state, owner, and settings; a person who is not an administrator sees only their own.",
		risk: "read",
		audience: "staff",
		tool: true,
		input: { params: UuidParam },
		output: Workspace,
	},
	"POST /workspaces/:id/start": {
		name: "workspaces.start",
		description:
			"Asks for a stopped workspace to be started, and returns at once while it starts.",
		risk: "change",
		audience: "staff",
		tool: true,
		input: { params: UuidParam },
	},
	"POST /workspaces/:id/stop": {
		name: "workspaces.stop",
		description:
			"Asks for a running workspace to be stopped, and returns at once while it stops.",
		risk: "change",
		audience: "staff",
		tool: true,
		input: { params: UuidParam },
	},
	"POST /workspaces/:id/restart": {
		name: "workspaces.restart",
		description:
			"Asks for a workspace to be stopped and started again, and returns at once while it restarts.",
		risk: "change",
		audience: "staff",
		tool: true,
		input: { params: UuidParam },
	},
	"GET /admin/workspaces/:id": {
		name: "workspaces.get_detail",
		description:
			"Returns an administrator's full view of one workspace: owner, live resource use, open ports, limits, and recent activity.",
		risk: "read",
		audience: "administrator",
		tool: true,
		input: { params: UuidParam },
		output: AdminWorkspaceDetail,
	},
	"GET /admin/workspaces/:id/agent-log": {
		name: "workspaces.agent_log",
		description:
			"Returns the recent warnings the workspace's own helper program reported, for a running workspace.",
		risk: "read",
		audience: "administrator",
		tool: true,
		input: { params: UuidParam },
		output: AgentLogResponse,
	},
	"POST /admin/workspaces/:id/archive": {
		name: "workspaces.archive",
		description:
			"Archives a workspace: it is stopped and cannot be started again until it is unarchived. Returns the updated workspace.",
		risk: "change",
		audience: "administrator",
		tool: false,
		input: { params: UuidParam },
		output: Workspace,
	},
	"POST /admin/workspaces/:id/unarchive": {
		name: "workspaces.unarchive",
		description:
			"Lets an archived workspace be started again. Returns the updated workspace.",
		risk: "change",
		audience: "administrator",
		tool: false,
		input: { params: UuidParam },
		output: Workspace,
	},
	"POST /admin/workspaces/:id/lift-throttle": {
		name: "workspaces.lift_throttle",
		description:
			"Removes the processor limit placed on a workspace for using too much, and tells its owner.",
		risk: "change",
		audience: "administrator",
		tool: false,
		input: { params: UuidParam },
	},
	"POST /admin/workspaces/:id/clear-memory-flag": {
		name: "workspaces.clear_memory_flag",
		description: "Clears the warning that marks a workspace as using too much memory.",
		risk: "change",
		audience: "administrator",
		tool: false,
		input: { params: UuidParam },
	},
	"POST /admin/workspaces/:id/reprovision": {
		name: "workspaces.reprovision",
		description:
			"Sends a workspace that is stuck in an error back to be created again, keeping the student's files. Returns the updated workspace.",
		risk: "change",
		audience: "administrator",
		tool: false,
		input: { params: UuidParam },
		output: Workspace,
	},
	"PUT /admin/workspaces/:id/quota": {
		name: "workspaces.set_quota",
		description:
			"Grows the disk space of a workspace's home folder or Docker storage; sizes can only go up. Returns the updated workspace.",
		risk: "change",
		audience: "administrator",
		tool: false,
		input: { params: UuidParam, body: UpdateQuotaRequest },
		output: Workspace,
	},
	"PUT /admin/workspaces/:id/guard": {
		name: "workspaces.set_guard",
		description:
			"Changes the usage thresholds at which one workspace is slowed or flagged, overriding the site defaults.",
		risk: "change",
		audience: "administrator",
		tool: false,
		input: { params: UuidParam, body: UpdateGuardRequest },
	},
	"PUT /admin/workspaces/:id/limits": {
		name: "workspaces.set_limits",
		description:
			"Sets the processor, memory, and process-count limits for one workspace, or returns them to the defaults.",
		risk: "change",
		audience: "administrator",
		tool: false,
		input: { params: UuidParam, body: UpdateLimitsRequest },
	},
	"POST /admin/workspaces/:id/rebuild": {
		name: "workspaces.rebuild",
		description:
			"Rebuilds a workspace from the current image, replacing everything outside the student's home folder, and can also wipe its Docker storage.",
		risk: "destructive",
		audience: "administrator",
		tool: true,
		input: { params: UuidParam, body: RebuildWorkspaceRequest },
	},
	"POST /workspaces/:id/reset-docker": {
		name: "workspaces.reset_docker",
		description:
			"Wipes a workspace's Docker storage (images, containers and volumes), and returns at once while it is cleared.",
		risk: "destructive",
		audience: "staff",
		tool: true,
		input: { params: UuidParam },
	},
	"GET /admin/workspaces/:id/processes": {
		name: "workspaces.list_processes",
		description:
			"Returns the latest list of programs running inside a workspace, as of the last refresh.",
		risk: "read",
		audience: "administrator",
		tool: true,
		input: { params: UuidParam },
		output: AdminProcessSnapshot,
	},
	"POST /admin/workspaces/:id/processes/refresh": {
		name: "workspaces.refresh_processes",
		description:
			"Asks for a fresh list of the programs running inside a running workspace; read it a moment later with workspaces.list_processes.",
		risk: "read",
		audience: "administrator",
		tool: false,
		input: { params: UuidParam },
	},
	"POST /admin/workspaces/:id/processes/:pid/stop": {
		name: "workspaces.stop_process",
		description:
			"Stops one program running inside a workspace, using the start time from the process list to be sure it is the same program, and tells the owner.",
		risk: "change",
		audience: "administrator",
		tool: false,
		input: { params: ProcessStopParams, body: ProcessStopRequest },
		output: ProcessStopResponse,
	},
};

/** Routes of this family that are exposed but have no record yet. */
export const pending: readonly string[] = [];
