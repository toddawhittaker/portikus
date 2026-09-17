/**
 * Runs the API's in-memory fake workspace agent on a fixed port so the
 * browser tests have something to attach terminals to. The real agent runs
 * inside a container, which the end-to-end environment does not start.
 */
import { startFakeAgent } from "../apps/api/dist/fake-agent.js";

const port = Number(process.env.FAKE_AGENT_PORT ?? "7400");
const token = process.env.FAKE_AGENT_TOKEN ?? "e2e-agent-token";

await startFakeAgent(token, { port });
