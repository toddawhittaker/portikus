import {
	CloneUrl,
	displayNameFromDirectory,
	MAX_PROJECT_NAME_LENGTH,
	type ProjectTemplate,
	slugify,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { Kysely, Selectable } from "kysely";

/**
 * What a Deep Linking link opens: a project name and exactly one of a
 * configured template or a public https repository (ADR 0058).
 */
export type StarterChoice =
	| { projectName: string; template: string; repositoryUrl: null }
	| { projectName: string; template: null; repositoryUrl: string };

/** The custom parameter names a picked link carries, in both directions. */
const STARTER_PARAMS = {
	project: "portikus_project",
	template: "portikus_template",
	repository: "portikus_repository",
} as const;

/** How long a student's starter launch waits for the web app to use it. */
const STARTER_LIFETIME_MS = 30 * 60 * 1000;

export type StarterLaunchRow = Selectable<Database["lti_starter_launches"]>;

/** Only a public https repository: no ssh, no credentials (ADR 0058). */
function isPublicHttpsRepository(url: string): boolean {
	return url.startsWith("https://") && CloneUrl.safeParse(url).success;
}

/** The repository's folder name read as a title: `.../ipeds-oracle.git` reads "Ipeds Oracle". */
function repositoryProjectName(url: string): string {
	const folder = (new URL(url).pathname.split("/").filter(Boolean).pop() ?? "").replace(
		/\.git$/,
		"",
	);
	return displayNameFromDirectory(folder);
}

/** What is wrong with a choice, so the picker can say so. */
export type StarterProblem = "source" | "template" | "repository" | "name";

/**
 * Check a choice from the picker form or a launch's custom parameters.
 * A blank project name takes the template's name or the repository's
 * folder name.
 */
export function parseStarterChoice(
	input: { projectName?: string; template?: string; repositoryUrl?: string },
	templates: readonly ProjectTemplate[],
): StarterChoice | StarterProblem {
	const typed = (input.projectName ?? "").trim();
	if (typed.length > MAX_PROJECT_NAME_LENGTH) return "name";
	const hasTemplate = input.template !== undefined && input.template !== "";
	const hasRepository = input.repositoryUrl !== undefined && input.repositoryUrl !== "";
	if (hasTemplate === hasRepository) return "source";

	let choice: StarterChoice;
	if (hasTemplate) {
		const template = templates.find((t) => t.name === input.template);
		if (!template) return "template";
		choice = {
			projectName: typed || template.name,
			template: template.name,
			repositoryUrl: null,
		};
	} else {
		const url = (input.repositoryUrl ?? "").trim();
		if (!isPublicHttpsRepository(url)) return "repository";
		choice = {
			projectName: typed || repositoryProjectName(url),
			template: null,
			repositoryUrl: url,
		};
	}
	return slugify(choice.projectName) === "" ? "name" : choice;
}

/** The custom parameters a picked link carries. */
export function starterCustomParameters(choice: StarterChoice): Record<string, string> {
	return choice.template !== null
		? {
				[STARTER_PARAMS.project]: choice.projectName,
				[STARTER_PARAMS.template]: choice.template,
			}
		: {
				[STARTER_PARAMS.project]: choice.projectName,
				[STARTER_PARAMS.repository]: choice.repositoryUrl,
			};
}

/**
 * The starter a launch's custom parameters name: null when the link is not
 * a Deep Linking link, "invalid" when it names something unusable now (a
 * template since removed, say).
 */
export function starterFromCustom(
	custom: Record<string, string>,
	templates: readonly ProjectTemplate[],
): StarterChoice | "invalid" | null {
	const projectName = custom[STARTER_PARAMS.project];
	if (projectName === undefined) return null;
	const template = custom[STARTER_PARAMS.template];
	const repositoryUrl = custom[STARTER_PARAMS.repository];
	// A link names its project, so a blank name is not filled in here.
	if (projectName.trim() === "") return "invalid";
	const choice = parseStarterChoice(
		{
			projectName,
			...(template === undefined ? {} : { template }),
			...(repositoryUrl === undefined ? {} : { repositoryUrl }),
		},
		templates,
	);
	return typeof choice === "string" ? "invalid" : choice;
}

/** Record a student's starter launch, bound to them; returns its id. */
export async function saveStarterLaunch(
	db: Kysely<Database>,
	userId: string,
	choice: StarterChoice,
	now = new Date(),
): Promise<string> {
	// Expired rows of this user go first, so they never pile up.
	await db
		.deleteFrom("lti_starter_launches")
		.where("user_id", "=", userId)
		.where("expires_at", "<=", now)
		.execute();
	const row = await db
		.insertInto("lti_starter_launches")
		.values({
			user_id: userId,
			project_name: choice.projectName,
			template: choice.template,
			repository_url: choice.repositoryUrl,
			expires_at: new Date(now.getTime() + STARTER_LIFETIME_MS).toISOString(),
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return row.id;
}

/** This user's unexpired starter launch, or undefined for any other id. */
export function findStarterLaunch(
	db: Kysely<Database>,
	id: string,
	userId: string,
	now = new Date(),
): Promise<StarterLaunchRow | undefined> {
	return db
		.selectFrom("lti_starter_launches")
		.selectAll()
		.where("id", "=", id)
		.where("user_id", "=", userId)
		.where("expires_at", ">", now)
		.executeTakeFirst();
}

/** A starter is used once: dropped when its project is created or opened. */
export async function consumeStarterLaunch(
	db: Kysely<Database>,
	id: string,
): Promise<void> {
	await db.deleteFrom("lti_starter_launches").where("id", "=", id).execute();
}
