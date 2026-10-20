import { expect, test } from "vitest";
import { createWorkspaceHub, type HubSocket } from "./workspace-hub.js";

function fakeSocket(open = true): HubSocket & { sent: unknown[] } {
	const sent: unknown[] = [];
	return {
		OPEN: 1,
		readyState: open ? 1 : 3,
		sent,
		send: (data) => sent.push(JSON.parse(data)),
	};
}

test("a layout announcement reaches every added socket of that workspace only", () => {
	const hub = createWorkspaceHub();
	const a = fakeSocket();
	const b = fakeSocket();
	const other = fakeSocket();
	hub.add("w1", a);
	hub.add("w1", b);
	hub.add("w2", other);
	hub.announceLayout("w1", "p1", 3);
	expect(a.sent).toEqual([{ type: "layout", projectId: "p1", version: 3 }]);
	expect(b.sent).toEqual(a.sent);
	expect(other.sent).toEqual([]);
});

test("a removed or closed socket gets nothing", () => {
	const hub = createWorkspaceHub();
	const gone = fakeSocket();
	const closed = fakeSocket(false);
	const remove = hub.add("w1", gone);
	hub.add("w1", closed);
	remove();
	hub.announceLayout("w1", "p1", 1);
	expect(gone.sent).toEqual([]);
	expect(closed.sent).toEqual([]);
});
