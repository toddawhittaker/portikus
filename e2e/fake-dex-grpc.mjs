/**
 * Runs an in-memory stand-in for Dex's gRPC API, with mutual TLS, so the
 * browser tests can add, reset and remove Dex users (docs/archive/epics/EPIC-14.md ruling 31).
 * The real Dex is tested by the CI dex-signin job.
 */
import {
	startFakeDexGrpc,
	writeDexGrpcCerts,
} from "../packages/auth/dist/testing/fake-dex-grpc.js";

const port = Number(process.env.FAKE_DEX_GRPC_PORT ?? "5557");
const dir = process.env.FAKE_DEX_GRPC_CERT_DIR;
if (!dir) throw new Error("FAKE_DEX_GRPC_CERT_DIR is required");

await startFakeDexGrpc(writeDexGrpcCerts(dir, "e2e"), port);
