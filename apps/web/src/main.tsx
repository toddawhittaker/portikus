import { ToastProvider } from "@portikus/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createQueryClient } from "./api/queryClient.js";
import "./app.css";
import { recordNotification } from "./notifications/queries.js";
import { router } from "./router.js";
import {
	clearStaleChunkFlag,
	installStaleChunkReload,
} from "./shell/reloadOnStaleChunk.js";
import { applyThemePreference, readThemePreference } from "./shell/theme.js";

const container = document.getElementById("root");
if (!container) {
	throw new Error("missing #root element");
}

// A tab left open across a deploy reloads once when it asks for a chunk
// the new build no longer ships (see reloadOnStaleChunk.ts).
installStaleChunkReload();
window.addEventListener("load", () => clearStaleChunkFlag());

// Before the first paint, so a remembered dark theme does not flash light.
applyThemePreference(readThemePreference());

const queryClient = createQueryClient(() => {
	void router.navigate({ to: "/session-ended" });
});

createRoot(container).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<ToastProvider onShow={(toast) => void recordNotification(queryClient, toast)}>
				<RouterProvider router={router} />
			</ToastProvider>
		</QueryClientProvider>
	</StrictMode>,
);
