import { ToastProvider } from "@portikus/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createQueryClient } from "./api/queryClient.js";
import "./app.css";
import { router } from "./router.js";
import { applyThemePreference, readThemePreference } from "./shell/theme.js";

const container = document.getElementById("root");
if (!container) {
	throw new Error("missing #root element");
}

// Before the first paint, so a remembered dark theme does not flash light.
applyThemePreference(readThemePreference());

const queryClient = createQueryClient(() => {
	void router.navigate({ to: "/session-ended" });
});

createRoot(container).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<ToastProvider>
				<RouterProvider router={router} />
			</ToastProvider>
		</QueryClientProvider>
	</StrictMode>,
);
