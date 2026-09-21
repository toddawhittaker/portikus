import { requireUser } from "@portikus/auth";
import {
	EDITOR_SETTINGS_DEFAULTS,
	EditorSettings,
	UpdateEditorSettingsRequest,
} from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import type { ServerDeps } from "../server.js";
import { sendError } from "./project-scope.js";

/** Stored settings as we read them back: every field optional (issue #159). */
const StoredEditorSettings = EditorSettings.partial();

/**
 * Fill in the defaults for anything the user has not set, and ignore anything
 * stored that is no longer a setting we know (issue #159).
 */
export function toEditorSettings(stored: unknown): EditorSettings {
	// Not strict: unknown keys are stripped, the known ones are kept.
	const parsed = StoredEditorSettings.safeParse(stored ?? {});
	return { ...EDITOR_SETTINGS_DEFAULTS, ...(parsed.success ? parsed.data : {}) };
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
		const body: EditorSettings = toEditorSettings(row?.editor_settings);
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

		const out: EditorSettings = toEditorSettings(updated.editor_settings);
		return out;
	});
}
