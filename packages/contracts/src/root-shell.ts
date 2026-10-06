import { z } from "zod";

/** `GET /admin/root-shell`: whether this server offers root shells (ADR 0051). */
export const RootShellStatus = z.object({ enabled: z.boolean() });
export type RootShellStatus = z.infer<typeof RootShellStatus>;

/** Why a root shell ended, as its `admin.root_shell_closed` audit row says (ADR 0051). */
export const RootShellCloseReason = z.enum([
	"exit",
	"client",
	"session_ended",
	"api_stopped",
]);
export type RootShellCloseReason = z.infer<typeof RootShellCloseReason>;
