import type { HealthResponse } from "@portikus/contracts";
import { useEffect, useState } from "react";
import { useMe } from "./useMe";
import { useWorkspaceSocket } from "./useWorkspaceSocket";

/** The single page of the shell: API health, sign in or out, and the workspace. */
export function Home() {
	const [health, setHealth] = useState<HealthResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const { me, signedOut } = useMe();
	const workspace = useWorkspaceSocket(me.status === "authenticated", signedOut);

	useEffect(() => {
		let cancelled = false;
		fetch("/health")
			.then((response) => response.json())
			.then((body: HealthResponse) => {
				if (!cancelled) setHealth(body);
			})
			.catch(() => {
				if (!cancelled) setError("API unavailable");
			});
		return () => {
			cancelled = true;
		};
	}, []);

	return (
		<main>
			<h1>Portikus</h1>
			<p data-testid="health">
				{health ? `api: ${health.status}` : (error ?? "checking api...")}
			</p>

			{me.status === "anonymous" && (
				<p>
					{/* A real navigation, so the session cookie is set on the way back. */}
					<a data-testid="signin" href="/auth/login">
						Sign in
					</a>
				</p>
			)}

			{me.status === "authenticated" && (
				<>
					<p data-testid="me">
						Signed in as {me.user.displayName} ({me.user.role})
					</p>
					<form method="post" action="/auth/logout">
						<button data-testid="signout" type="submit">
							Sign out
						</button>
					</form>
					<section>
						<h2>Workspace</h2>
						{workspace ? (
							<ul>
								<li data-testid="workspace-state">state: {workspace.state}</li>
								<li>desired state: {workspace.desiredState}</li>
								<li>connections: {workspace.activeConnections}</li>
							</ul>
						) : (
							<p data-testid="workspace-state">state: connecting...</p>
						)}
					</section>
				</>
			)}
		</main>
	);
}
