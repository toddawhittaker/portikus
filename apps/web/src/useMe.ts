import { useCallback, useEffect, useState } from "react";

export type Role = "student" | "administrator";

export interface MeUser {
	id: string;
	email: string | null;
	displayName: string;
	role: Role;
}

export type MeState =
	| { status: "loading" }
	| { status: "anonymous" }
	| { status: "authenticated"; user: MeUser };

/**
 * Reads the current session from `GET /auth/me`. A 401 means nobody is
 * signed in.
 */
export function useMe(): { me: MeState; signedOut: () => void } {
	const [me, setMe] = useState<MeState>({ status: "loading" });

	useEffect(() => {
		let cancelled = false;
		fetch("/auth/me", { credentials: "same-origin" })
			.then(async (response) => {
				if (response.status === 401) {
					if (!cancelled) setMe({ status: "anonymous" });
					return;
				}
				const user = (await response.json()) as MeUser;
				if (!cancelled) setMe({ status: "authenticated", user });
			})
			.catch(() => {
				if (!cancelled) setMe({ status: "anonymous" });
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const signedOut = useCallback(() => {
		setMe({ status: "anonymous" });
	}, []);

	return { me, signedOut };
}
