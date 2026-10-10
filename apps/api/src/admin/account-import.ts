import {
	ACCOUNT_IMPORT_COLUMNS,
	ACCOUNT_IMPORT_MAX_BYTES,
	ACCOUNT_IMPORT_MAX_ROWS,
	type AccountImportPreviewRow,
	CreateDexUserRequest,
	CreateInvitationRequest,
	CsvError,
	parseCsv,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import { type Kysely, sql } from "kysely";
import type { ZodError } from "zod";

/**
 * Reading and checking an account import file (SPEC.md section 5.1, "Add
 * user"; section 24.13). Nothing here writes; the route creates the rows
 * this marks valid.
 */

type Column = (typeof ACCOUNT_IMPORT_COLUMNS)[number];

/** A data row as written in the file, fields trimmed. */
export type ImportRow = { line: number; fieldCount: number } & Record<Column, string>;

/** A whole-file problem: the file is refused before any row is looked at. */
export class ImportFileError extends Error {}

/** Administrators are added one at a time, never from a spreadsheet. */
export const ADMIN_ROW_REASON =
	"Administrators cannot be imported. Add them one at a time with Add user or Invite.";

/** The data rows of an import file, or ImportFileError for a bad file. */
export function readImportFile(text: string): ImportRow[] {
	if (Buffer.byteLength(text, "utf8") > ACCOUNT_IMPORT_MAX_BYTES) {
		throw new ImportFileError("The file is larger than 256 KB.");
	}
	let records: string[][];
	try {
		records = parseCsv(text);
	} catch (err) {
		if (err instanceof CsvError) throw new ImportFileError(err.message);
		throw err;
	}
	const [header, ...data] = records;
	if (!header) throw new ImportFileError("The file is empty.");
	const names = header.map((cell) => cell.trim().toLowerCase());
	for (const name of names) {
		if (!(ACCOUNT_IMPORT_COLUMNS as readonly string[]).includes(name)) {
			throw new ImportFileError(
				`Unknown column "${name}". The header must name ${ACCOUNT_IMPORT_COLUMNS.join(", ")}.`,
			);
		}
	}
	for (const column of ACCOUNT_IMPORT_COLUMNS) {
		const count = names.filter((n) => n === column).length;
		if (count !== 1) {
			throw new ImportFileError(
				count === 0
					? `The header has no "${column}" column.`
					: `The header names "${column}" more than once.`,
			);
		}
	}
	if (data.length === 0)
		throw new ImportFileError("The file has no rows after the header.");
	if (data.length > ACCOUNT_IMPORT_MAX_ROWS) {
		throw new ImportFileError(
			`The file has ${data.length} rows; at most ${ACCOUNT_IMPORT_MAX_ROWS} are allowed.`,
		);
	}
	return data.map((record, index) => {
		const cell = (column: Column) => (record[names.indexOf(column)] ?? "").trim();
		return {
			line: index + 2,
			fieldCount: record.length,
			name: cell("name"),
			email: cell("email"),
			username: cell("username"),
			role: cell("role"),
			kind: cell("kind"),
		};
	});
}

/** A row ready to create, in the form the single-account paths take. */
type ValidImport =
	| { kind: "password"; body: CreateDexUserRequest }
	| { kind: "invite"; body: CreateInvitationRequest };

export interface ClassifiedRow {
	preview: AccountImportPreviewRow;
	/** Set only when the preview status is valid. */
	valid: ValidImport | null;
}

function firstIssue(error: ZodError): string {
	const issue = error.issues[0];
	const field = String(issue?.path[0] ?? "row");
	return `${field}: ${issue?.message ?? "invalid"}`;
}

/** The row's shape alone: what it would create, or why it cannot. */
function checkShape(row: ImportRow, dexEnabled: boolean): ValidImport | string {
	if (row.fieldCount !== ACCOUNT_IMPORT_COLUMNS.length) {
		return `The row has ${row.fieldCount} fields; the header has ${ACCOUNT_IMPORT_COLUMNS.length}.`;
	}
	const kind = row.kind.toLowerCase();
	const role = row.role.toLowerCase();
	if (kind !== "password" && kind !== "invite")
		return "Kind must be password or invite.";
	if (role === "administrator") return ADMIN_ROW_REASON;
	if (role !== "student" && role !== "instructor") {
		return "Role must be student or instructor.";
	}
	if (kind === "password") {
		if (!dexEnabled) {
			return "This site has no Portikus passwords. Use kind invite instead.";
		}
		const body = CreateDexUserRequest.safeParse({
			name: row.name,
			email: row.email,
			username: row.username,
			role,
		});
		return body.success ? { kind, body: body.data } : firstIssue(body.error);
	}
	const body = CreateInvitationRequest.safeParse({
		name: row.name,
		email: row.email,
		role,
		...(row.username ? { username: row.username } : {}),
	});
	return body.success ? { kind, body: body.data } : firstIssue(body.error);
}

/**
 * Mark each row valid, invalid, or a duplicate of an existing account, a
 * waiting invitation, or an earlier row. Run again at confirm, so the
 * client's copy of the preview is never trusted.
 */
export async function classifyImport(
	db: Kysely<Database>,
	opts: { issuer: string; dexEnabled: boolean },
	rows: ImportRow[],
): Promise<ClassifiedRow[]> {
	const shaped = rows.map((row) => ({ row, shape: checkShape(row, opts.dexEnabled) }));
	const emails = new Set<string>();
	const usernames = new Set<string>();
	for (const { shape } of shaped) {
		if (typeof shape === "string") continue;
		emails.add(shape.body.email);
		if (shape.body.username) usernames.add(shape.body.username.toLowerCase());
	}
	const takenEmails = new Set<string>();
	const takenDexUsernames = new Set<string>();
	const invitedEmails = new Set<string>();
	const invitedUsernames = new Set<string>();
	if (emails.size > 0) {
		const list = [...emails];
		const users = await db
			.selectFrom("users")
			.select(sql<string>`lower(email)`.as("email"))
			.where(sql<string>`lower(email)`, "in", list)
			.execute();
		for (const u of users) takenEmails.add(u.email);
		const invites = await db
			.selectFrom("account_invitations")
			.select(["email", "username"])
			.where("claimed_at", "is", null)
			.where("revoked_at", "is", null)
			.where((eb) =>
				usernames.size > 0
					? eb.or([eb("email", "in", list), eb("username", "in", [...usernames])])
					: eb("email", "in", list),
			)
			.execute();
		for (const i of invites) {
			invitedEmails.add(i.email);
			if (i.username) invitedUsernames.add(i.username);
		}
	}
	if (usernames.size > 0) {
		const users = await db
			.selectFrom("users")
			.select(sql<string>`lower(preferred_username)`.as("username"))
			.where("oidc_issuer", "=", opts.issuer)
			.where(sql<string>`lower(preferred_username)`, "in", [...usernames])
			.execute();
		for (const u of users) takenDexUsernames.add(u.username);
	}

	const seenEmail = new Map<string, number>();
	const seenUsername = new Map<string, number>();
	return shaped.map(({ row, shape }) => {
		const preview: AccountImportPreviewRow = {
			line: row.line,
			name: row.name,
			email: row.email,
			username: row.username,
			role: row.role,
			kind: row.kind,
			status: "valid",
			reason: null,
		};
		if (typeof shape === "string") {
			return { preview: { ...preview, status: "invalid", reason: shape }, valid: null };
		}
		const email = shape.body.email;
		const username = shape.body.username?.toLowerCase();
		const duplicate = (reason: string): ClassifiedRow => ({
			preview: { ...preview, status: "duplicate", reason },
			valid: null,
		});
		const earlier =
			seenEmail.get(email) ?? (username ? seenUsername.get(username) : undefined);
		if (!seenEmail.has(email)) seenEmail.set(email, row.line);
		if (username && !seenUsername.has(username)) seenUsername.set(username, row.line);
		if (earlier !== undefined) return duplicate(`Repeats row ${earlier}.`);
		if (takenEmails.has(email))
			return duplicate("An account with this email already exists.");
		if (invitedEmails.has(email)) {
			return duplicate("An invitation for this email is already waiting.");
		}
		if (shape.kind === "password" && username && takenDexUsernames.has(username)) {
			return duplicate("An account with this username already exists.");
		}
		if (shape.kind === "invite" && username && invitedUsernames.has(username)) {
			return duplicate("An invitation for this sign-in name is already waiting.");
		}
		return { preview, valid: shape };
	});
}
