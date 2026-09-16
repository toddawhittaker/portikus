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
			// The workspace routes include the WebSocket upgrade.
			"/workspaces": { ...api, ws: true },
		},
	},
});
