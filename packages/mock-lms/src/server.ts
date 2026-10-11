import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { html, readForm, send } from "./http.js";
import { autoPostPage, errorPage, framePage, launchPage } from "./pages.js";
import { createRosters } from "./roster.js";
import {
	CLIENT_ID,
	type Course,
	DEPLOYMENT_ID,
	findCourse,
	findPerson,
	findRosterPerson,
	isRoleName,
	type Person,
	type RoleName,
} from "./seed.js";
import { createServices } from "./services.js";
import {
	type ContentLink,
	type DeepLinkRequest,
	type Defect,
	isDefect,
	launchClaims,
	type Signer,
	signLaunch,
} from "./token.js";
import { type FetchToolKeys, fetchKeysFrom } from "./tool.js";

export interface MockLmsOptions {
	issuer: string;
	toolUrl: string;
	signer: Signer;
	log: (line: string) => void;
	now?: () => number;
	/** Where the tool's public keys come from; defaults to its /lti/jwks. */
	fetchToolKeys?: FetchToolKeys;
}

interface PendingLaunch {
	person: Person;
	course: Course;
	role: RoleName;
	defect?: Defect;
	deepLink?: DeepLinkRequest;
	link?: ContentLink;
}

const MAX_PENDING = 1000;

export function registration(issuer: string) {
	return {
		name: "mock-lms",
		issuer,
		clientId: CLIENT_ID,
		authLoginUrl: `${issuer}/authorize`,
		authTokenUrl: `${issuer}/token`,
		keysetUrl: `${issuer}/.well-known/jwks.json`,
		deploymentIds: [DEPLOYMENT_ID],
		mock: true,
	};
}

export function createHandler(options: MockLmsOptions) {
	const { issuer, toolUrl, signer, log } = options;
	const now = options.now ?? (() => Math.floor(Date.now() / 1000));
	const rosters = createRosters();
	const services = createServices({
		issuer,
		fetchKeys: options.fetchToolKeys ?? fetchKeysFrom(toolUrl),
		now,
		rosters,
		log,
	});
	// Launches stay valid for the life of the process: the frame fallback re-submits the same hint.
	const pending = new Map<string, PendingLaunch>();
	let previousToken: string | undefined; // the last good launch's token
	let previousExp = 0; // its exp claim, in seconds
	// Stops another site from making the operator's browser start a launch (login CSRF).
	const formToken = randomBytes(32).toString("base64url");
	const formTokenOk = (value: string | null) => {
		const given = Buffer.from(value ?? "");
		const expected = Buffer.from(formToken);
		return given.length === expected.length && timingSafeEqual(given, expected);
	};

	function loginFields(id: string, launch: PendingLaunch): Record<string, string> {
		return {
			iss: issuer,
			login_hint: launch.person.key,
			target_link_uri: launch.link?.url ?? `${toolUrl}/`,
			lti_message_hint: id,
			client_id: CLIENT_ID,
			lti_deployment_id: DEPLOYMENT_ID,
		};
	}

	function start(params: URLSearchParams, res: ServerResponse) {
		if (!formTokenOk(params.get("form_token"))) {
			return html(
				res,
				403,
				errorPage("Start the launch from this mock's launch page."),
			);
		}
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
		return begin(launch, params.get("frame") === "1", res);
	}

	function begin(launch: PendingLaunch, frameIt: boolean, res: ServerResponse) {
		const id = randomUUID();
		if (pending.size >= MAX_PENDING) {
			const oldest = pending.keys().next().value;
			if (oldest !== undefined) pending.delete(oldest);
		}
		pending.set(id, launch);
		if (frameIt) return html(res, 200, framePage(`/frame?launch=${id}`));
		return html(
			res,
			200,
			autoPostPage(`${toolUrl}/lti/login`, loginFields(id, launch)),
		);
	}

	function startDeepLink(params: URLSearchParams, res: ServerResponse) {
		if (!formTokenOk(params.get("form_token"))) {
			return html(res, 403, errorPage("Start from this mock's launch page."));
		}
		const person = findPerson(params.get("person") ?? "");
		const course = findCourse(params.get("course") ?? "");
		if (!person) return html(res, 400, errorPage("Choose a person from the list."));
		if (!course) return html(res, 400, errorPage("Choose a course from the list."));
		return begin(
			{
				person,
				course,
				role: person.role,
				deepLink: {
					returnUrl: `${issuer}/deeplink/return`,
					data: services.newDeepLinkData(course.key),
				},
			},
			false,
			res,
		);
	}

	function launchLink(params: URLSearchParams, res: ServerResponse) {
		if (!formTokenOk(params.get("form_token"))) {
			return html(res, 403, errorPage("Start from this mock's launch page."));
		}
		const person = findPerson(params.get("person") ?? "");
		const link = services.links.get(params.get("link") ?? "");
		const course = link ? findCourse(link.courseKey) : undefined;
		if (!person) return html(res, 400, errorPage("Choose a person from the list."));
		if (!link || !course) return html(res, 400, errorPage("Choose a saved link."));
		return begin({ person, course, role: person.role, link }, false, res);
	}

	/** Test hook: change a course roster. Needs the same form token as a launch. */
	function changeRoster(params: URLSearchParams, res: ServerResponse) {
		if (!formTokenOk(params.get("form_token"))) {
			return html(res, 403, errorPage("Start from this mock's launch page."));
		}
		const action = params.get("action");
		if (action === "reset") {
			rosters.reset();
			return send(res, 204, "text/plain; charset=utf-8", "");
		}
		const courseKey = params.get("course") ?? "";
		const personKey = params.get("person") ?? "";
		const roleParam = params.get("role") ?? "";
		const person = findRosterPerson(personKey);
		if (roleParam !== "" && !isRoleName(roleParam)) {
			return html(res, 400, errorPage("Choose a role from the list."));
		}
		let done = false;
		if (action === "add" && person) {
			done = rosters.add(courseKey, person, roleParam === "" ? person.role : roleParam);
		} else if (action === "drop") {
			done = rosters.drop(courseKey, personKey);
		} else if (action === "role" && roleParam !== "") {
			done = rosters.setRole(courseKey, personKey, roleParam);
		}
		if (!done) return html(res, 400, errorPage("That roster change names no one."));
		return send(res, 204, "text/plain; charset=utf-8", "");
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

	/** What is wrong with the OIDC parameters of an authorize request, if anything. */
	function authorizeRequestProblem(params: URLSearchParams): string | null {
		if (!(params.get("scope") ?? "").split(" ").includes("openid")) {
			return "scope must include openid.";
		}
		if (params.get("response_type") !== "id_token")
			return "response_type must be id_token.";
		const mode = params.get("response_mode");
		if (mode !== null && mode !== "form_post")
			return "response_mode must be form_post.";
		if (params.get("client_id") !== CLIENT_ID) return "client_id is not this tool's.";
		// Posting a signed token to any other address would make this an open redirector.
		if (params.get("redirect_uri") !== `${toolUrl}/lti/launch`) {
			return "redirect_uri is not this tool's launch URL.";
		}
		return null;
	}

	async function authorize(params: URLSearchParams, res: ServerResponse) {
		const refuse = (message: string) => html(res, 400, errorPage(message));
		const requestProblem = authorizeRequestProblem(params);
		if (requestProblem) return refuse(requestProblem);
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
			// An expired replay would fail on exp as well as on its nonce.
			if (now() >= previousExp) {
				return refuse(
					"The last good launch's token has expired. Launch once more without a defect, then replay.",
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
				deepLink: launch.deepLink,
				link: launch.link,
				nonce,
				now: now(),
				defect,
			});
			idToken = await signLaunch(signer, claims, defect);
			// Replay only a good token, so the replay fails on its nonce and nothing else.
			if (defect === undefined) {
				previousToken = idToken;
				previousExp = Number(claims.exp);
			}
		}
		// Never the token, and nothing about the person beyond the seed key.
		log(`launch person=${launch.person.key} defect=${defect ?? "none"}`);
		return html(
			res,
			200,
			autoPostPage(`${toolUrl}/lti/launch`, { id_token: idToken, state }),
		);
	}

	const getRoutes: Record<
		string,
		(params: URLSearchParams, res: ServerResponse) => void | Promise<void>
	> = {
		"/": (_params, res) =>
			html(res, 200, launchPage(toolUrl, formToken, [...services.links.values()])),
		"/.well-known/jwks.json": (_params, res) =>
			send(res, 200, "application/json", JSON.stringify(signer.jwks)),
		"/frame": frame,
	};

	// POST routes that take a form body.
	const formRoutes: Record<
		string,
		(params: URLSearchParams, res: ServerResponse) => void | Promise<void>
	> = {
		"/start": start,
		"/deeplink/start": startDeepLink,
		"/deeplink/return": services.deepLinkReturn,
		"/launch-link": launchLink,
		"/roster": changeRoster,
		"/token": services.token,
	};

	return async function handle(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		const url = new URL(req.url ?? "/", "http://mock-lms.invalid");
		const method = req.method ?? "GET";
		try {
			const getRoute = method === "GET" ? getRoutes[url.pathname] : undefined;
			if (getRoute) return getRoute(url.searchParams, res);
			const formRoute = method === "POST" ? formRoutes[url.pathname] : undefined;
			if (formRoute) return await formRoute(await readForm(req), res);
			if (method === "GET" && url.pathname.startsWith("/nrps/")) {
				return services.memberships(req, url, res);
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
