import { PreviewGrantRequest } from "@portikus/contracts";
import { afterEach, expect, test, vi } from "vitest";
import { json, stubFetch } from "../../test-utils.js";
import { LiveListening, openLivePreview, serviceLabel } from "./previews.js";

const REF = { courseId: "c1", sessionId: "s1" };
const BOOTSTRAP =
	"https://ws-1234abcd-5173.preview.example.edu/__portikus/bootstrap?t=x";

afterEach(() => vi.unstubAllGlobals());

function grantAnswer(status: number) {
	return stubFetch(() =>
		status === 200
			? json(200, {
					previewOrigin: "https://ws-1234abcd-5173.preview.example.edu",
					bootstrapUrl: BOOTSTRAP,
					expiresAt: "2026-10-12T10:00:00.000Z",
				})
			: json(status, { code: "VALIDATION_FAILED", message: "invalid grant request" }),
	);
}

test("opening a preview asks for a top-level grant the API accepts and loads it in the tab", async () => {
	const fetch = grantAnswer(200);
	const tab = { opener: {} as unknown, location: { replace: vi.fn() }, close: vi.fn() };
	const open = vi.fn(() => tab);
	vi.stubGlobal("open", open);

	expect(await openLivePreview(REF, 5173)).toBe(true);

	const [url, init] = fetch.mock.calls[0] ?? [];
	expect(url).toBe("/courses/c1/live-help/s1/preview-grants");
	const body = JSON.parse(String(init?.body));
	expect(body).toEqual({ port: 5173, presentation: "top-level" });
	expect(PreviewGrantRequest.safeParse(body).success).toBe(true);
	// The tab is opened inside the click, cut from this page, then pointed at the grant.
	expect(open).toHaveBeenCalledWith("about:blank", "_blank");
	expect(tab.opener).toBeNull();
	expect(tab.location.replace).toHaveBeenCalledWith(BOOTSTRAP);
});

test("a refused grant closes the blank tab and reports failure", async () => {
	grantAnswer(400);
	const tab = { opener: {}, location: { replace: vi.fn() }, close: vi.fn() };
	vi.stubGlobal(
		"open",
		vi.fn(() => tab),
	);
	expect(await openLivePreview(REF, 5173)).toBe(false);
	expect(tab.close).toHaveBeenCalled();
	expect(tab.location.replace).not.toHaveBeenCalled();
});

test("a listener with only a port still parses and has no label", () => {
	const bare = LiveListening.parse({ port: 8000 });
	expect(bare.port).toBe(8000);
	expect(bare.system).toBe(false);
	expect(serviceLabel(bare)).toBeUndefined();
	expect(
		serviceLabel(LiveListening.parse({ port: 8000, process: {} })),
	).toBeUndefined();
});

test("the label is the container name, else the process name", () => {
	expect(
		serviceLabel(
			LiveListening.parse({
				port: 80,
				container: { name: "web" },
				process: { command: "nginx" },
			}),
		),
	).toBe("web");
	expect(
		serviceLabel(LiveListening.parse({ port: 3000, process: { command: "node" } })),
	).toBe("node");
});
