import type { Role, UsersFile } from "./schema.js";

// Group names Portikus maps through OIDC_ADMIN_GROUP, OIDC_INSTRUCTOR_GROUP and OIDC_STUDENT_GROUP.
export const groupForRole: Record<Role, string> = {
	student: "portikus-students",
	instructor: "instructor",
	administrator: "portikus-administrators",
};

export type DexStaticPassword = {
	email: string;
	hash: string;
	username: string;
	name: string;
	preferredUsername: string;
	userID: string;
	emailVerified: true;
	groups: string[];
};

// The `staticPasswords` list for Dex's config, one entry per user.
export function toDexStaticPasswords(file: UsersFile): DexStaticPassword[] {
	return file.users.map((user) => ({
		email: user.email,
		hash: user.passwordHash,
		username: user.username,
		name: user.displayName,
		preferredUsername: user.username,
		userID: user.userId,
		emailVerified: true,
		groups: [groupForRole[user.role]],
	}));
}
