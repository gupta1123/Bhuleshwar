import { createServer } from "node:http";
import next from "next";

import { startCaseTallyGateway } from "../case-tally-gateway/src/server.mjs";

const port = Number.parseInt(process.env.PORT || "3001", 10);
const hostname = process.env.HOST || "0.0.0.0";
const app = next({ dev: false, dir: process.cwd(), hostname, port });
const handle = app.getRequestHandler();

await app.prepare();

const httpServer = createServer((request, response) => handle(request, response));

const caseTallyGateway = startCaseTallyGateway({
  server: httpServer,
  path: "/agent-live",
  legacyPaths: ["/cash-discount-live"],
  apiBaseUrl: process.env.CASE_TALLY_API_BASE_URL || `http://127.0.0.1:${port}`,
});

httpServer.listen(port, hostname, () => {
  console.log(`API listening on http://${hostname}:${port}`);
});

function shutdown(signal) {
  console.log(`${signal} received; closing API and case Tally gateway.`);
  caseTallyGateway.close(() => httpServer.close(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
