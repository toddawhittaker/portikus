import {
	alertChannelsFromConfig,
	anyAlertChannel,
	sendAlert,
} from "@portikus/observability";

/**
 * `portikus alert` and `portikus alert-failed` (STACK.md section 15): one
 * alert to every channel in the worker's environment, through its outbound
 * proxy, with the same bodies the worker sends. Exit 0 when every channel
 * took it or none is set, 1 when one failed, 2 for a usage error.
 */
export async function runAlertCommand(
	args: readonly string[],
	env: NodeJS.ProcessEnv,
	print: (line: string) => void,
	printError: (line: string) => void,
	site?: string,
	pushoverUrl?: string,
): Promise<number> {
	const [tone, title, text] = args;
	if (args.length !== 3 || (tone !== "warning" && tone !== "danger")) {
		print("usage: alert-main.js warning|danger TITLE TEXT");
		return 2;
	}
	const channels = alertChannelsFromConfig({
		ALERT_PUSHOVER_USER_KEY: env.ALERT_PUSHOVER_USER_KEY ?? "",
		ALERT_PUSHOVER_APP_TOKEN: env.ALERT_PUSHOVER_APP_TOKEN ?? "",
		ALERT_WEBHOOK_URL: env.ALERT_WEBHOOK_URL ?? "",
		OUTBOUND_PROXY_URL: env.OUTBOUND_PROXY_URL || undefined,
	});
	if (!anyAlertChannel(channels)) {
		print("portikus: no alert channel is set in alerts.env; nothing sent");
		return 0;
	}
	const results = await sendAlert(
		channels,
		{ title: title ?? "", text: text ?? "", tone, at: new Date() },
		site,
		pushoverUrl,
	);
	for (const r of results) {
		if (r.ok) print(`portikus: the ${r.channel} alert was sent`);
		else printError(`portikus: the ${r.channel} alert could not be sent (${r.error})`);
	}
	return results.every((r) => r.ok) ? 0 : 1;
}
