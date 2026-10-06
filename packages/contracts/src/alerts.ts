import { z } from "zod";

/** What `POST /admin/alerts/test` reports for each configured channel (STACK.md section 15). */
export const AlertChannelResult = z.object({
	channel: z.enum(["pushover", "webhook", "email", "ntfy", "teams"]),
	ok: z.boolean(),
	error: z.string().optional(),
});
export type AlertChannelResult = z.infer<typeof AlertChannelResult>;

/** An empty list means no alert channel is configured. */
export const TestAlertResponse = z.object({
	results: z.array(AlertChannelResult),
});
export type TestAlertResponse = z.infer<typeof TestAlertResponse>;
