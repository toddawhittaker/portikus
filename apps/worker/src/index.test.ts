import { expect, test } from "vitest";
import { describeService } from "./index.js";

test("describes itself", () => {
	expect(describeService()).toBe("portikus worker");
});

// Reconciler tests are in reconcile.test.ts (real Postgres required).
