import { MAX_TERMINAL_SOCKETS_PER_USER } from "@portikus/contracts";
import { createSocketSlots } from "./socket-slots.js";

/**
 * Terminal sockets open per user, workspace terminals and root shells
 * together (SPEC.md §24.13, ADR 0051).
 */
export const terminalSockets = createSocketSlots(MAX_TERMINAL_SOCKETS_PER_USER);
