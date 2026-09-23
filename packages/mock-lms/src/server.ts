import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { autoPostPage, errorPage, framePage, launchPage } from "./pages.js";
import {
	CLIENT_ID,
	type Course,
	DEPLOYMENT_ID,
	findCourse,
	findPerson,
	isRoleName,
	type Person,
	type RoleName,
} from "./seed.js";
import {
	type Defect,
	isDefect,
	launchClaims,
	type Signer,
	signLaunch,
} from "./token.js";

export interface MockLmsOptions {
	issuer: string;
	toolUrl: string;
	signer: Signer;
	log: (line: string) => void;
	now?: () => number;
}

interface PendingLaunch {
	person: Person;
	course: Course;
	role: RoleName;
	defect?: Defect;
}

const MAX_PENDING = 1000;
const MAX_BODY_BYTES = 64 * 1024;

export function registration(issuer: string) {
	return {
		name: "mock-lms",
		issuer,
		clientId: CLIENT_ID,
		authLoginUrl: `${issuer}/authorize`,
		keysetUrl: `${issuer}/.well-known/jwks.json`,
		deploymentIds: [DEPLOYMENT_ID],
		mock: true,
	};
}

export function createHandler(options: MockLmsOptions) {
	const { issuer, toolUrl, signer, log } = options;
	const now = options.now ?? (() => Math.floor(Date.now() / 1000));
	// Launches stay valid for the life of the process: the frame fallback re-submits the same hint.
	const pending = new Map<string, PendingLaunch>();
	let previousToken: string | undefined;

	function send(res: ServerResponse, status: number, type: string, body: string) {
		res.writeHead(status, {
			"content-type": type,
			"cache-control": "no-store",
			"referrer-policy": "no-referrer",
		});
		res.end(body);
	}
	const html = (res: ServerResponse, status: number, body: string) =>
		send(res, status, "text/html; charset=utf-8", body);

	function loginFields(id: string, launch: PendingLaunch): Record<string, string> {
		return {
			iss: issuer,
			login_hint: launch.person.key,
			target_link_uri: `${toolUrl}/`,
			lti_message_hint: id,
			client_id: CLIENT_ID,
			lti_deployment_id: DEPLOYMENT_ID,
		};
	}

	function start(params: URLSearchParams, res: ServerResponse) {
		const person = findPerson(params.get("person") ?? "");
		const course = findCourse(params.get("course") ?? "");
		const roleParam = params.get("role") ?? "";
		const defectParam = params.get("defect") ?? "";
		if (!person) return html(res, 400, errorPage("Choose a person from the list."));
		if (!course) return html(res, 400, errorPage("Choose a course from the list."));
		if (roleParam !== "" && !isRoleName(roleParam)) {
			return html(res, 400, errorPage("Choose a role from the list."));
		}
		if (defectParam !== "" && !isDefect(defectParam)) {
			return html(res, 400, errorPage("Choose a defect from the list."));
		}
		const launch: PendingLaunch = {
			person,
			course,
			role: roleParam === "" ? person.role : roleParam,
			defect: defectParam === "" ? undefined : defectParam,
		};
		const id = randomUUID();
		if (pending.size >= MAX_PENDING) {
			const oldest = pending.keys().next().value;
			if (oldest !== undefined) pending.delete(oldest);
		}
		pending.set(id, launch);
		if (params.get("frame") === "1")
			return html(res, 200, framePage(`/frame?launch=${id}`));
		return html(
			res,
			200,
			autoPostPage(`${toolUrl}/lti/login`, loginFields(id, launch)),
		);
	}

	function frame(params: URLSearchParams, res: ServerResponse) {
		const id = params.get("launch") ?? "";
		const launch = pending.get(id);
		if (!launch)
			return html(res, 404, errorPage("That launch is unknown. Start again."));
		return html(
			res,
			200,
			autoPostPage(`${toolUrl}/lti/login`, loginFields(id, launch)),
		);
	}

	async function authorize(params: URLSearchParams, res: ServerResponse) {
		const refuse = (message: string) => html(res, 400, errorPage(message));
		if (!(params.get("scope") ?? "").split(" ").includes("openid")) {
			return refuse("scope must include openid.");
		}
		if (params.get("response_type") !== "id_token")
			return refuse("response_type must be id_token.");
		const mode = params.get("response_mode");
		if (mode !== null && mode !== "form_post")
			return refuse("response_mode must be form_post.");
		if (params.get("client_id") !== CLIENT_ID)
			return refuse("client_id is not this tool's.");
		// Posting a signed token to any other address would make this an open redirector.
		if (params.get("redirect_uri") !== `${toolUrl}/lti/launch`) {
			return refuse("redirect_uri is not this tool's launch URL.");
		}
		const state = params.get("state") ?? "";
		const nonce = params.get("nonce") ?? "";
		if (state === "" || nonce === "") return refuse("state and nonce are required.");
		const launch = pending.get(params.get("lti_message_hint") ?? "");
		if (!launch) return refuse("lti_message_hint names no launch started here.");
		if (params.get("login_hint") !== launch.person.key) {
			return refuse("login_hint does not match the launch.");
		}
		const defectParam = params.get("defect");
		if (defectParam !== null && defectParam !== "" && !isDefect(defectParam)) {
			return refuse("defect is not a known defect name.");
		}
		const defect = defectParam ? (defectParam as Defect) : launch.defect;

		let idToken: string;
		if (defect === "replayed_nonce") {
			if (previousToken === undefined) {
				return refuse(
					"replayed_nonce needs an earlier launch to replay. Launch once first.",
				);
			}
			idToken = previousToken;
		} else {
			const claims = launchClaims({
				issuer,
				toolUrl,
				person: launch.person,
				course: launch.course,
				role: launch.role,
				nonce,
				now: now(),
				defect,
			});
			idToken = await signLaunch(signer, claims, defect);
			previousToken = idToken;
		}
		// Never the token, and nothing about the person beyond the seed key.
		log(`launch person=${launch.person.key} defect=${defect ?? "none"}`);
		return html(
			res,
			200,
			autoPostPage(`${toolUrl}/lti/launch`, { id_token: idToken, state }),
		);
	}

	return async function handle(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		const url = new URL(req.url ?? "/", "http://mock-lms.invalid");
		const method = req.method ?? "GET";
		try {
			if (method === "GET" && url.pathname === "/")
				return html(res, 200, launchPage(toolUrl));
			if (method === "GET" && url.pathname === "/.well-known/jwks.json") {
				return send(res, 200, "application/json", JSON.stringify(signer.jwks));
			}
			if (method === "GET" && url.pathname === "/frame")
				return frame(url.searchParams, res);
			if (method === "POST" && url.pathname === "/start") {
				return start(await readForm(req), res);
			}
			if (url.pathname === "/authorize" && (method === "GET" || method === "POST")) {
				const params = method === "POST" ? await readForm(req) : new URLSearchParams();
				for (const [key, value] of url.searchParams) {
					if (!params.has(key)) params.set(key, value);
				}
				return await authorize(params, res);
			}
			return send(res, 404, "text/plain; charset=utf-8", "Not found\n");
		} catch {
			return send(res, 400, "text/plain; charset=utf-8", "Bad request\n");
		}
	};
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY_BYTES) throw new Error("body too large");
		chunks.push(chunk as Buffer);
	}
	return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}
