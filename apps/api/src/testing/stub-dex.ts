import type { DexApi, DexPassword } from "@portikus/auth";

/** Dex's passwords, by email, with a switch that makes every call fail. */
export function stubDex() {
	const passwords = new Map<string, DexPassword & { hash: string }>();
	const state = { failing: false };
	const guard = () => {
		if (state.failing) throw Object.assign(new Error("unavailable"), { code: 14 });
	};
	const dex: DexApi = {
		async createPassword(input) {
			guard();
			if (passwords.has(input.email)) return "already_exists";
			passwords.set(input.email, { ...input });
			return "created";
		},
		async updatePassword(email, hash) {
			guard();
			const stored = passwords.get(email);
			if (!stored) return "not_found";
			stored.hash = hash;
			return "updated";
		},
		async deletePassword(email) {
			guard();
			return passwords.delete(email) ? "deleted" : "not_found";
		},
		async listPasswords() {
			guard();
			return [...passwords.values()].map(({ email, username, userId }) => ({
				email,
				username,
				userId,
			}));
		},
		async verifyPassword() {
			return "not_found";
		},
		close() {},
	};
	return { dex, passwords, state };
}
