import { requireUser } from "@portikus/auth";
import {
	Appearance,
	EDITOR_SETTINGS_DEFAULTS,
	EditorSettings,
	isSystemTimezone,
	MAX_PROFILE_PICTURE_BYTES,
	type MeSettings,
	PICTURE_TOO_LARGE_MESSAGE,
	type Profile,
	systemTimezones,
	UpdateEditorSettingsRequest,
	UpdateProfileRequest,
} from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import type { ServerDeps } from "../server.js";
import { sendError } from "./project-scope.js";

/**
 * The zone list this build knows, built once. It is the same list for every
 * request, and working it out per request costs a few hundred strings.
 */
const TIMEZONES: string[] = [...systemTimezones()];

/**
 * Fill in the defaults for anything the user has not set, and ignore anything
 * stored that is no longer a setting we know (issue #159).
 *
 * Each field is parsed on its own, so one bad stored value (for example a
 * zone name this build no longer knows, issue #287) falls back to its own
 * default and takes none of the student's other settings with it.
 */
export function toEditorSettings(stored: unknown): EditorSettings {
	const raw = (stored ?? {}) as Record<string, unknown>;
	const out: Record<string, unknown> = { ...EDITOR_SETTINGS_DEFAULTS };
	for (const [key, schema] of Object.entries(EditorSettings.shape)) {
		const parsed = schema.safeParse(raw[key]);
		if (parsed.success) out[key] = parsed.data;
	}
	if (!isSystemTimezone(out.timezone)) out.timezone = EDITOR_SETTINGS_DEFAULTS.timezone;
	return out as EditorSettings;
}

/** Whether the user has saved an appearance, rather than getting the default. */
function hasStoredAppearance(stored: unknown): boolean {
	const value = (stored as { appearance?: unknown } | null | undefined)?.appearance;
	return Appearance.safeParse(value).success;
}

/**
 * The picture's real type, read from its first bytes rather than trusted
 * from the request header, or null when it is neither png nor jpeg.
 */
export function pictureType(bytes: Buffer): "image/png" | "image/jpeg" | null {
	const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	if (bytes.length >= png.length && png.every((byte, i) => bytes[i] === byte)) {
		return "image/png";
	}
	if (
		bytes.length >= 3 &&
		bytes[0] === 0xff &&
		bytes[1] === 0xd8 &&
		bytes[2] === 0xff
	) {
		return "image/jpeg";
	}
	return null;
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
			appearanceStored: hasStoredAppearance(row?.editor_settings),
		};
		return body;
	});

	app.put("/me/settings", async (request, reply) => {
		const user = requireUser(request);

		const body = UpdateEditorSettingsRequest.safeParse(request.body ?? {});
		if (!body.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", body.error.message);
		}

		// Merged in the one statement, so two saves at once both survive.
		const updated = await db
			.updateTable("users")
			.set({
				editor_settings: sql`coalesce(editor_settings, '{}'::jsonb) || ${JSON.stringify(body.data)}::jsonb`,
				updated_at: new Date().toISOString(),
			})
			.where("id", "=", user.id)
			.returning("editor_settings")
			.executeTakeFirst();
		if (!updated) {
			return sendError(reply, 404, "NOT_FOUND", "User not found");
		}

		// Same shape as GET, so the browser's cached copy keeps the zone list.
		const out: MeSettings = {
			...toEditorSettings(updated.editor_settings),
			timezones: TIMEZONES,
			appearanceStored: hasStoredAppearance(updated.editor_settings),
		};
		return out;
	});

	registerProfileRoutes(app, db);
}

/**
 * The signed-in user's own profile (issue #300). Every route reads and writes
 * the caller's row only, and nothing here is used for authorization
 * (SPEC.md §13.5, §24). Picture bytes are never logged.
 */
function registerProfileRoutes(app: FastifyInstance, db: ServerDeps["db"]): void {
	async function readProfile(userId: string): Promise<Profile | null> {
		const row = await db
			.selectFrom("users")
			.leftJoin("workspaces", "workspaces.owner_user_id", "users.id")
			.select([
				"users.display_name",
				"users.email",
				"users.profile_github",
				"users.profile_website",
				"users.picture_updated_at",
				"workspaces.label",
			])
			.where("users.id", "=", userId)
			.executeTakeFirst();
		if (!row) return null;
		return {
			displayName: row.display_name,
			email: row.email,
			workspaceLabel: row.label ?? null,
			github: row.profile_github,
			website: row.profile_website,
			// The version in the query string makes a new picture show at once.
			picture: row.picture_updated_at
				? `/me/picture?v=${new Date(row.picture_updated_at).getTime()}`
				: null,
		};
	}

	app.get("/me/profile", async (request, reply) => {
		const user = requireUser(request);
		const profile = await readProfile(user.id);
		if (!profile) return sendError(reply, 404, "NOT_FOUND", "User not found");
		return profile;
	});

	app.put("/me/profile", async (request, reply) => {
		const user = requireUser(request);
		const body = UpdateProfileRequest.safeParse(request.body ?? {});
		if (!body.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", body.error.message);
		}
		const changes: { profile_github?: string | null; profile_website?: string | null } =
			{};
		if (body.data.github !== undefined) changes.profile_github = body.data.github;
		if (body.data.website !== undefined) changes.profile_website = body.data.website;
		await db
			.updateTable("users")
			.set({ ...changes, updated_at: new Date().toISOString() })
			.where("id", "=", user.id)
			.execute();
		return await readProfile(user.id);
	});

	app.get("/me/picture", async (request, reply) => {
		const user = requireUser(request);
		const row = await db
			.selectFrom("users")
			.select(["picture", "picture_type"])
			.where("id", "=", user.id)
			.executeTakeFirst();
		if (!row?.picture || !row.picture_type) {
			return sendError(reply, 404, "NOT_FOUND", "No picture");
		}
		// Only a versioned URL is cached for long; the bare URL must not
		// linger in a shared lab computer's cache after sign-out.
		const versioned = (request.query as { v?: unknown }).v !== undefined;
		reply.header(
			"cache-control",
			versioned ? "private, max-age=31536000, immutable" : "private, no-cache",
		);
		reply.header("x-content-type-options", "nosniff");
		reply.type(row.picture_type);
		return reply.send(row.picture);
	});

	app.delete("/me/picture", async (request) => {
		const user = requireUser(request);
		await db
			.updateTable("users")
			.set({
				picture: null,
				picture_type: null,
				picture_updated_at: null,
				updated_at: new Date().toISOString(),
			})
			.where("id", "=", user.id)
			.execute();
		return await readProfile(user.id);
	});

	// Its own plugin so this one route sees the raw bytes and its own cap.
	app.register(async (upload) => {
		upload.removeAllContentTypeParsers();
		upload.addContentTypeParser(
			"*",
			{ parseAs: "buffer", bodyLimit: MAX_PROFILE_PICTURE_BYTES },
			(_request, body, done) => done(null, body),
		);
		upload.setErrorHandler((error, _request, reply) => {
			if ((error as { statusCode?: number }).statusCode === 413) {
				return sendError(reply, 413, "FILE_TOO_LARGE", PICTURE_TOO_LARGE_MESSAGE);
			}
			throw error;
		});

		upload.put("/me/picture", async (request, reply) => {
			const user = requireUser(request);
			const bytes = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
			const type = pictureType(bytes);
			if (!type) {
				return sendError(
					reply,
					415,
					"VALIDATION_FAILED",
					"The picture must be a PNG or JPEG image",
				);
			}
			const now = new Date().toISOString();
			await db
				.updateTable("users")
				.set({
					picture: bytes,
					picture_type: type,
					picture_updated_at: now,
					updated_at: now,
				})
				.where("id", "=", user.id)
				.execute();
			return await readProfile(user.id);
		});
	});
}
