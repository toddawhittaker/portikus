import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { TerminalPane } from "./TerminalPane";
import { TerminalTabs } from "./TerminalTabs";
import { useMe } from "./useMe";
import { useTerminals } from "./useTerminals";
import { useWorkspaceSocket } from "./useWorkspaceSocket";
import { WorkspaceStarting } from "./WorkspaceStarting";

/** The workspace screen: the starting state, then the terminal tabs. */
export function WorkspacePage() {
	const { id } = useParams({ from: "/workspaces/$id" });
	const { me, signedOut } = useMe();
	const workspace = useWorkspaceSocket(me.status === "authenticated", signedOut);
	const running = workspace?.state === "running";
	// The route names the workspace; the socket reports its state. The server
	// returns 404 for a workspace the signed-in user does not own.
	const { terminals, error, create, rename, close, markEnded } = useTerminals(
		id,
		running,
		signedOut,
	);
	const [activeId, setActiveId] = useState<string | null>(null);

	// Keep a sensible tab selected as terminals come and go.
	useEffect(() => {
		if (terminals.length === 0) {
			setActiveId(null);
			return;
		}
		const last = terminals[terminals.length - 1];
		if (last && !terminals.some((terminal) => terminal.id === activeId)) {
			setActiveId(last.id);
		}
	}, [terminals, activeId]);

	if (me.status === "loading") return <main>Loading…</main>;
	if (me.status === "anonymous") {
		return (
			<main>
				<p>
					<a href="/auth/login">Sign in</a>
				</p>
			</main>
		);
	}

	return (
		<main className="pk-workspace">
			<p>
				<Link to="/">Back to home</Link>
			</p>
			{!running || !workspace ? (
				<WorkspaceStarting workspace={workspace} />
			) : (
				<>
					{error && <p role="alert">{error}</p>}
					<TerminalTabs
						terminals={terminals}
						activeId={activeId}
						onSelect={setActiveId}
						onCreate={() => {
							void create().then((created) => {
								if (created) setActiveId(created.id);
							});
						}}
						onRename={(terminalId, name) => void rename(terminalId, name)}
						onClose={(terminalId) => void close(terminalId)}
						onRestart={(ended) => {
							void create({ name: ended.name, cwd: ended.cwd }).then((created) => {
								if (created) setActiveId(created.id);
							});
						}}
					/>
					{terminals.map((terminal) => (
						<TerminalPane
							key={terminal.id}
							workspaceId={id}
							terminal={terminal}
							visible={terminal.id === activeId}
							onExit={markEnded}
							onSessionEnded={signedOut}
						/>
					))}
					{terminals.length === 0 && <p>No terminals yet. Use “+” to open one.</p>}
				</>
			)}
		</main>
	);
}
