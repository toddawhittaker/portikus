import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest runs without globals here, so React Testing Library cannot register its
// own automatic cleanup. Unmount between tests so queries see one render at a time.
afterEach(cleanup);
