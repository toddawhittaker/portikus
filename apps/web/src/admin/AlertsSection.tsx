import {
	type TestAlertResponse,
	TestAlertResponse as TestAlertSchema,
} from "@portikus/contracts";
import { Button } from "@portikus/ui";
import { useMutation } from "@tanstack/react-query";
import { errorText, request } from "../api/request.js";
import { AdminGroup } from "./AdminSection.js";

const CHANNEL_NAME = {
	pushover: "Pushover",
	webhook: "Webhook",
	email: "Email",
	ntfy: "ntfy",
	teams: "Microsoft Teams",
} as const;

/** One sentence per channel, or why nothing was sent. */
function describe(response: TestAlertResponse): string[] {
	if (response.results.length === 0)
		return [
			"No alert channel is set up, so nothing was sent. Set the Pushover keys or a webhook URL in /etc/portikus/secrets.yaml on the server, then run sudo portikus setup.",
		];
	return response.results.map((r) =>
		r.ok
			? `${CHANNEL_NAME[r.channel]}: sent.`
			: `${CHANNEL_NAME[r.channel]}: not sent (${r.error ?? "failed"}).`,
	);
}

/**
 * Warnings and failures on the admin bell are also pushed to Pushover or a
 * webhook (STACK.md section 15); this checks that delivery works.
 */
export function AlertsSection() {
	const send = useMutation({
		mutationFn: () =>
			request(TestAlertSchema, "/admin/alerts/test", { method: "POST" }),
	});
	return (
		<AdminGroup
			id="alerts-title"
			title="Alerts"
			description="Warnings and failures that need a person are also sent to Pushover or a webhook, when one is set up."
			testId="alerts-section"
		>
			<div className="flex flex-col items-start gap-2">
				<Button
					variant="secondary"
					data-testid="send-test-alert"
					loading={send.isPending}
					onClick={() => send.mutate()}
				>
					Send test alert
				</Button>
				<div role="status" data-testid="test-alert-result">
					{send.isSuccess &&
						describe(send.data).map((line) => <p key={line}>{line}</p>)}
					{send.isError && <p>{errorText(send.error)}</p>}
				</div>
			</div>
		</AdminGroup>
	);
}
