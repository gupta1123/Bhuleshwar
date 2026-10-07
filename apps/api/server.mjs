import { createServer } from "node:http";
import next from "next";

const port = Number.parseInt(process.env.PORT || "3001", 10);
const hostname = process.env.HOST || "0.0.0.0";
const app = next({ dev: false, dir: process.cwd(), hostname, port });
const handle = app.getRequestHandler();

await app.prepare();

const httpServer = createServer((request, response) => handle(request, response));

httpServer.listen(port, hostname, () => {
  console.log(`API listening on http://${hostname}:${port}`);
});

function shutdown(signal) {
  console.log(`${signal} received; closing API.`);
  httpServer.close(() => process.exit(0));
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
