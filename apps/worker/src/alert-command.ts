import { DEFAULT_NOTIFY_FILE } from "@portikus/config";
import {
	type AlertChannels,
	anyAlertChannel,
	errorMessage,
	readAlertChannels,
	sendAlert,
} from "@portikus/observability";

/**
 * `portikus alert` and `portikus alert-failed` (STACK.md section 15): one
 * alert to every channel in notify.json, through the worker's outbound
 * proxy, with the same bodies the worker sends. Exit 0 when every channel
 * took it or none is set, 1 when one failed or the settings cannot be read,
 * 2 for a usage error.
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
	const path = env.NOTIFY_FILE || DEFAULT_NOTIFY_FILE;
	let channels: AlertChannels;
	try {
		channels = await readAlertChannels(path, env.OUTBOUND_PROXY_URL || undefined);
	} catch (e) {
		printError(`portikus: ${errorMessage(e)}; nothing sent`);
		return 1;
	}
	if (!anyAlertChannel(channels)) {
		print(`portikus: no alert channel is set in ${path}; nothing sent`);
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
