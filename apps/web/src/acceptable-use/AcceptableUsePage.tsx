import { AcceptableUseResponse } from "@portikus/contracts";
import { Button } from "@portikus/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { z } from "zod";
import { ApiError, request } from "../api/request.js";
import { StandalonePage } from "../pages/StandalonePage.js";
import { useMe } from "../useMe.js";

/** Plain text; a blank line starts a new paragraph (docs/EPIC-14-3.md ruling 29). */
export function paragraphs(text: string): string[] {
	return text
		.split(/\n\s*\n/)
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

/**
 * The acceptable-use statement every account accepts before anything else
 * (docs/EPIC-14-3.md rulings 31 to 33); the router sends every page here.
 */
export function AcceptableUsePage() {
	const me = useMe();
	const client = useQueryClient();
	const navigate = useNavigate();
	const signOutForm = useRef<HTMLFormElement>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	// The heading renders once the session loads, so focus it then.
	useEffect(() => {
		if (me.status === "authenticated") heading.current?.focus();
	}, [me.status]);
	const statement = useQuery({
		queryKey: ["acceptable-use"],
		queryFn: () => request(AcceptableUseResponse, "/me/acceptable-use"),
		enabled: me.status === "authenticated",
	});
	const accept = useMutation({
		mutationFn: (version: number) =>
			request(z.undefined(), "/me/acceptable-use", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ version }),
			}),
		onSuccess: async () => {
			// The gate is clear now; refetch so the router stops sending pages here.
			await client.refetchQueries({ queryKey: ["me"] });
			await navigate({ to: "/", replace: true });
		},
		onError: async (error) => {
			// A newer text was saved meanwhile: show it, never accept it unseen.
			if (error instanceof ApiError && error.code === "ACCEPTABLE_USE_CHANGED") {
				await statement.refetch();
			}
		},
	});

	if (me.status === "loading") return <div className="pk-root" aria-busy="true" />;
	if (me.status !== "authenticated") return <Navigate to="/" replace />;

	return (
		<StandalonePage title="Acceptable use" testId="page-acceptable-use">
			<div className="flex flex-col gap-2">
				<h1 id="page-title" className="pk-text-display" tabIndex={-1} ref={heading}>
					Acceptable use
				</h1>
				<p className="pk-text-body">
					Read how Portikus may be used, then accept it to continue.
				</p>
			</div>
			{statement.data ? (
				<div className="flex flex-col gap-3" data-testid="acceptable-use-text">
					{paragraphs(statement.data.text).map((part, index) => (
						// The statement is static text, so its order is its identity.
						// biome-ignore lint/suspicious/noArrayIndexKey: paragraphs never reorder
						<p key={index} className="pk-text-body m-0 whitespace-pre-line">
							{part}
						</p>
					))}
				</div>
			) : statement.isError ? (
				<p role="alert" className="pk-text-body m-0 text-status-error">
					The statement could not be loaded. Reload the page to try again.
				</p>
			) : (
				<div aria-busy="true" />
			)}
			{accept.error ? (
				<p role="alert" className="pk-text-body m-0 text-status-error">
					{accept.error instanceof ApiError &&
					accept.error.code === "ACCEPTABLE_USE_CHANGED"
						? "The statement has just changed. Read the new one above, then accept it."
						: accept.error.message}
				</p>
			) : null}
			<hr className="pk-divider" />
			<div className="pk-actions">
				<Button
					variant="secondary"
					iconStart="sign-out"
					onClick={() => signOutForm.current?.requestSubmit()}
				>
					Sign out
				</Button>
				<Button
					variant="primary"
					disabled={!statement.data}
					loading={accept.isPending}
					onClick={() => {
						if (statement.data) accept.mutate(statement.data.version);
					}}
				>
					I accept
				</Button>
			</div>
			<form ref={signOutForm} method="post" action="/auth/logout" className="hidden" />
		</StandalonePage>
	);
}
