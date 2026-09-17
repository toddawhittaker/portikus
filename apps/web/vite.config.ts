import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = { target: "http://127.0.0.1:3000", changeOrigin: true };

export default defineConfig({
	plugins: [react()],
	server: {
		host: "127.0.0.1",
		port: 5173,
		strictPort: true,
		proxy: {
			"/health": api,
			"/auth": api,
			"/admin": api,
			// The workspace routes include the WebSocket upgrade. They are also
			// where the single-page application's own screens live, so a page
			// the browser asks for as a document is served from the bundle and
			// only data and socket requests reach the API.
			"/workspaces": {
				...api,
				ws: true,
				bypass: (req) =>
					req.headers.accept?.includes("text/html") ? "/index.html" : undefined,
			},
		},
	},
});
