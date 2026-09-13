import {createConnection, createServer} from "node:net";
import {randomUUID} from "node:crypto";
import {getPriority, setPriority} from "node:os";

// One machine-local slot, shared by tests, builds and browser probes. The OS
// releases the listener when its owner exits; there is no stale lock file.
const validationPort = 19479;
const sessionKey = "OPENVOXEL_VALIDATION_SESSION";

export function validationJobs(value) {
  if (value === undefined) return 1;
  if (!/^[1-4]$/u.test(value)) throw new Error("OPENVOXEL_VALIDATE_JOBS must be an integer from 1 to 4");
  return Number(value);
}

async function inheritedSession(port, token) {
  if (!token) return false;
  return new Promise((resolve) => {
    const socket = createConnection({host: "127.0.0.1", port});
    let response = "";
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(1000, () => finish(false));
    socket.on("error", () => finish(false));
    socket.on("connect", () => socket.end(`${token}\n`));
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.length > 64) finish(false);
    });
    socket.on("end", () => finish(response === "shared\n"));
  });
}

export async function acquireValidationSession({port = validationPort, env = process.env} = {}) {
  if (await inheritedSession(port, env[sessionKey])) return {shared: true, close: async () => {}};
  const token = randomUUID();
  const server = createServer((socket) => {
    let request = "";
    socket.setTimeout(1000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk) => {
      request += chunk;
      if (request.length > 128) socket.destroy();
      else if (request.includes("\n")) socket.end(request === `${token}\n` ? "shared\n" : "busy\n");
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", (error) => reject(error.code === "EADDRINUSE"
      ? new Error(`Validation slot 127.0.0.1:${port} is busy. Wait for the current OpenVoxel task to finish; no additional work was started.`)
      : error));
    server.listen(port, "127.0.0.1", resolve);
  });
  server.unref();
  env[sessionKey] = token;
  return {
    shared: false,
    port: server.address().port,
    close: () => new Promise((resolve, reject) => {
      if (env[sessionKey] === token) delete env[sessionKey];
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

export function lowerValidationPriority() {
  try {
    if (getPriority() < 10) setPriority(0, 10);
  } catch (error) {
    process.stderr.write(`Could not lower validation priority: ${error.message}\n`);
  }
  process.env.UV_THREADPOOL_SIZE ??= "2";
  process.env.VIPS_CONCURRENCY ??= "1";
}

export async function enterValidationSession() {
  const session = await acquireValidationSession();
  lowerValidationPriority();
  return session;
}
