import { z } from "zod";

export const USERNAME_PATTERN = /^[a-z][a-z0-9._-]{0,31}$/;
// Dex accepts bcrypt costs 10 to 16; 60 characters in all.
export const HASH_PATTERN = /^\$2[aby]\$1[0-6]\$[./A-Za-z0-9]{53}$/;

export const roles = ["student", "administrator"] as const;
export type Role = (typeof roles)[number];

const userSchema = z.strictObject({
	username: z.string().regex(USERNAME_PATTERN, "must match ^[a-z][a-z0-9._-]{0,31}$"),
	email: z.email(),
	displayName: z.string().min(1).max(100),
	role: z.enum(roles),
	userId: z.uuid(),
	passwordHash: z
		.string()
		.regex(HASH_PATTERN, "must be a bcrypt hash with a cost from 10 to 16"),
	// Shown by `list`; not rendered into Dex.
	passwordChangedAt: z.iso.datetime().optional(),
});

const fileSchema = z.strictObject({
	version: z.literal(1),
	users: z.array(z.unknown()),
});

export type User = z.infer<typeof userSchema>;
export type UsersFile = { version: 1; users: User[] };

export type ValidationResult =
	| { ok: true; file: UsersFile }
	| { ok: false; errors: string[] };

function describe(issues: z.core.$ZodIssue[]): string {
	return issues
		.map((issue) => {
			const path = issue.path.join(".");
			return path ? `${path}: ${issue.message}` : issue.message;
		})
		.join("; ");
}

// Checks everything `users-check` promises, and names the entry in each error.
export function validateUsersFile(data: unknown): ValidationResult {
	const top = fileSchema.safeParse(data);
	if (!top.success) {
		return { ok: false, errors: [`file: ${describe(top.error.issues)}`] };
	}
	const errors: string[] = [];
	const users: User[] = [];
	top.data.users.forEach((raw, index) => {
		const parsed = userSchema.safeParse(raw);
		const name =
			typeof raw === "object" && raw !== null && "username" in raw
				? String((raw as { username: unknown }).username)
				: `#${index + 1}`;
		if (parsed.success) {
			users.push(parsed.data);
		} else {
			errors.push(`user ${name}: ${describe(parsed.error.issues)}`);
		}
	});
	const seenNames = new Set<string>();
	const seenEmails = new Set<string>();
	for (const user of users) {
		if (seenNames.has(user.username)) {
			errors.push(`user ${user.username}: duplicate username`);
		}
		seenNames.add(user.username);
		const email = user.email.toLowerCase();
		if (seenEmails.has(email)) {
			errors.push(`user ${user.username}: duplicate email ${user.email}`);
		}
		seenEmails.add(email);
	}
	if (errors.length === 0 && !users.some((u) => u.role === "administrator")) {
		errors.push("file: at least one user must have the role administrator");
	}
	if (errors.length > 0) {
		return { ok: false, errors };
	}
	return { ok: true, file: { version: 1, users } };
}
