import { requireUser } from "@portikus/auth";
import {
	EDITOR_SETTINGS_DEFAULTS,
	EditorSettings,
	isSystemTimezone,
	type MeSettings,
	systemTimezones,
	UpdateEditorSettingsRequest,
} from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import type { ServerDeps } from "../server.js";
import { sendError } from "./project-scope.js";

/** Stored settings as we read them back: every field optional (issue #159). */
const StoredEditorSettings = EditorSettings.partial();

/**
 * The zone list this build knows, built once. It is the same list for every
 * request, and working it out per request costs a few hundred strings.
 */
const TIMEZONES: string[] = [...systemTimezones()];

/**
 * Fill in the defaults for anything the user has not set, and ignore anything
 * stored that is no longer a setting we know (issue #159).
 *
 * The zone is parsed on its own, because it is the one field that can stop
 * being valid while it sits in the database: a name this build no longer
 * knows reads back as the default (issue #287). Parsed with the rest, it
 * would take every other setting down with it and the student's auto-save,
 * word wrap and terminal colours would silently go back to the defaults.
 */
export function toEditorSettings(stored: unknown): EditorSettings {
	// Not strict: unknown keys are stripped, the known ones are kept.
	const parsed = StoredEditorSettings.safeParse(stored ?? {});
	const { timezone, ...rest } = parsed.success ? parsed.data : {};
	return {
		...EDITOR_SETTINGS_DEFAULTS,
		...rest,
		...(isSystemTimezone(timezone) ? { timezone } : {}),
	};
}

/**
 * The signed-in user's own editor settings (issue #159). Both routes read and
 * write the caller's row only, so one user can never see or change another
 * user's settings (SPEC.md §24).
 */
export function registerMeRoutes(app: FastifyInstance, { db }: ServerDeps): void {
	app.get("/me/settings", async (request) => {
		const user = requireUser(request);
		const row = await db
			.selectFrom("users")
			.select("editor_settings")
			.where("id", "=", user.id)
			.executeTakeFirst();
		// The zone list travels with the settings so the dialog can only offer
		// names PUT will accept (issue #287).
		const body: MeSettings = {
			...toEditorSettings(row?.editor_settings),
			timezones: TIMEZONES,
		};
		return body;
	});

	app.put("/me/settings", async (request, reply) => {
		const user = requireUser(request);

		const body = UpdateEditorSettingsRequest.safeParse(request.body ?? {});
		if (!body.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", body.error.message);
		}

		const before = await db
			.selectFrom("users")
			.select("editor_settings")
			.where("id", "=", user.id)
			.executeTakeFirst();
		if (!before) {
			return sendError(reply, 404, "NOT_FOUND", "User not found");
		}

		const merged: EditorSettings = {
			...toEditorSettings(before.editor_settings),
			...body.data,
		};

		const updated = await db
			.updateTable("users")
			.set({
				editor_settings: JSON.stringify(merged),
				updated_at: new Date().toISOString(),
			})
			.where("id", "=", user.id)
			.returning("editor_settings")
			.executeTakeFirstOrThrow();

		// Same shape as GET, so the browser's cached copy keeps the zone list.
		const out: MeSettings = {
			...toEditorSettings(updated.editor_settings),
			timezones: TIMEZONES,
		};
		return out;
	});
}
