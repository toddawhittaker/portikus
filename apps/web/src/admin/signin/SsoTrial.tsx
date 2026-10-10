import type { SigninTestResult, SigninView, SiteJobView } from "@portikus/contracts";
import { Button, HINT_CLASS, useToast } from "@portikus/ui";
import { useEffect, useRef, useState } from "react";
import { errorText } from "../../api/request.js";
import { longTime } from "../backups/model.js";
import { TEST_SIGNIN_URL, useEndTrial } from "./queries.js";
import { PROVIDER_LABEL, timeLeft } from "./ssoForm.js";

const ROLE_WORD = {
	student: "a student",
	instructor: "an instructor",
	administrator: "an administrator",
};

function resultText(test: SigninTestResult): string {
	const how = test.connector ? ` through the ${test.connector} connector` : "";
	if (test.result === "passed" && test.role) {
		return `Test sign-in passed ${longTime(test.at)}: signed in${how} as ${ROLE_WORD[test.role]}.`;
	}
	if (!test.role && test.connector) {
		return `Test sign-in failed ${longTime(test.at)}: signed in${how}, but no group matched a role.`;
	}
	return `Test sign-in failed ${longTime(test.at)}: the sign-in did not come through this provider.`;
}

/** An open sign-in trial: time left, Test sign-in, its result, Keep and Roll back (ADR 0059). */
export function SsoTrial({
	job,
	view,
	lastTest,
}: {
	job: SiteJobView;
	view: SigninView | null;
	lastTest: SigninTestResult | null;
}) {
	const toast = useToast();
	const end = useEndTrial();
	const now = useNow();
	const resultRef = useRef<HTMLParagraphElement>(null);
	const test = lastTest?.trialId === job.id ? lastTest : null;
	const dexOnly = view?.provider === "dex";
	const canKeep = dexOnly || test?.result === "passed";

	// Back from a test sign-in: put focus on its result, then drop the marker from the address.
	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		if (!params.has("test")) return;
		resultRef.current?.focus();
		params.delete("test");
		const search = params.toString();
		window.history.replaceState(
			window.history.state,
			"",
			`${window.location.pathname}${search ? `?${search}` : ""}`,
		);
	}, []);

	function finish(action: "keep" | "rollback") {
		if (action === "keep" && !canKeep) return;
		end.mutate(
			{ action, trialId: job.id },
			{
				onSuccess: () =>
					toast.show({
						tone: "success",
						title: action === "keep" ? "Keeping the new settings" : "Rolling back",
					}),
				onError: (error) =>
					toast.show({
						tone: "danger",
						title:
							action === "keep" ? "Could not keep the change" : "Could not roll back",
						children: errorText(error),
					}),
			},
		);
	}

	return (
		<div className="grid gap-4" data-testid="sso-trial">
			<p className="pk-text-body m-0">
				<span className="font-semibold">
					{view ? PROVIDER_LABEL[view.provider] : "The new settings"}
				</span>{" "}
				is on trial. If nobody keeps it, the earlier settings are put back in{" "}
				<span className="font-mono" data-testid="sso-trial-left">
					{job.trialEndsAt ? timeLeft(job.trialEndsAt, now) : "–"}
				</span>
				{job.trialEndsAt ? `, at ${longTime(job.trialEndsAt)}` : ""}.
			</p>
			<p
				ref={resultRef}
				tabIndex={-1}
				className="pk-text-compact m-0 outline-none"
				data-testid="sso-test-result"
			>
				{test
					? resultText(test)
					: dexOnly
						? "Local accounts need no test sign-in. Keep the change when you are ready."
						: "No test sign-in of this trial yet. Sign in as someone from the provider; you stay signed in as yourself."}
			</p>
			<div className="grid gap-2">
				<div className="pk-actions">
					{dexOnly ? null : (
						<Button
							data-testid="sso-test"
							onClick={() => window.location.assign(TEST_SIGNIN_URL)}
						>
							Test sign-in
						</Button>
					)}
					<Button
						variant="primary"
						data-testid="sso-keep"
						loading={end.isPending && end.variables?.action === "keep"}
						aria-disabled={canKeep ? undefined : true}
						aria-describedby={canKeep ? undefined : "sso-keep-note"}
						onClick={() => finish("keep")}
					>
						Keep
					</Button>
					<Button
						data-testid="sso-rollback"
						loading={end.isPending && end.variables?.action === "rollback"}
						onClick={() => finish("rollback")}
					>
						Roll back
					</Button>
				</div>
				{canKeep ? null : (
					<p id="sso-keep-note" className={HINT_CLASS}>
						Keep turns on after a test sign-in passes.
					</p>
				)}
			</div>
		</div>
	);
}

/** The time now, ticking each second for the countdown. */
function useNow(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	return now;
}
