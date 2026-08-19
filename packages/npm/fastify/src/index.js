import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { Buffer } from "node:buffer";

const OPEN = 1;

function integer(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function optionsOf(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Fastify backend options must be a record");
  }
  return Object.freeze({
    logger: value.logger === true,
    bodyLimit: integer(value.bodyLimit, 1, 16 * 1024 * 1024, "bodyLimit"),
    maxMessageBytes: integer(value.maxMessageBytes, 1, 64 * 1024 * 1024, "maxMessageBytes"),
    maxQueuedMessages: integer(value.maxQueuedMessages, 1, 10_000, "maxQueuedMessages"),
    maxQueuedBytes: integer(value.maxQueuedBytes, 1, 64 * 1024 * 1024, "maxQueuedBytes"),
    maxPendingSendBytes: integer(value.maxPendingSendBytes, 1, 64 * 1024 * 1024, "maxPendingSendBytes"),
    maxConnections: integer(value.maxConnections, 1, 100_000, "maxConnections"),
  });
}

function messageSize(message) {
  if (typeof message === "string") return Buffer.byteLength(message, "utf8");
  if (message instanceof Uint8Array) return message.byteLength;
  throw new TypeError("WebSocket messages must be text or Bytes");
}

function copyMessage(data, binary) {
  if (!binary) {
    const text = typeof data === "string" ? data : data.toString("utf8");
    return { value: text, size: Buffer.byteLength(text, "utf8") };
  }
  const source = data instanceof Uint8Array ? data : new Uint8Array(data);
  const value = new Uint8Array(source.byteLength);
  value.set(source);
  return { value, size: value.byteLength };
}

const socketStates = new WeakMap();

function finish(state) {
  if (state.finished) return;
  state.finished = true;
  if (state.waiter !== null) {
    const waiter = state.waiter;
    state.waiter = null;
    waiter.resolve(null);
  }
}

function abort(state, error) {
  state.finished = true;
  state.queue.length = 0;
  state.queuedBytes = 0;
  if (state.waiter !== null) {
    const waiter = state.waiter;
    state.waiter = null;
    if (error === null) waiter.resolve(null);
    else waiter.reject(error);
  }
}

export class FastifySocket {
  constructor(socket, limits) {
    const state = {
      socket,
      limits,
      queue: [],
      queuedBytes: 0,
      pendingSendBytes: 0,
      waiter: null,
      finished: false,
      closePromise: null,
    };
    socketStates.set(this, state);
    socket.on("message", (data, binary) => {
      if (state.finished) return;
      const message = copyMessage(data, binary);
      if (message.size > limits.maxMessageBytes) {
        abort(state, null);
        socket.close(1009, "Message too large");
        return;
      }
      if (state.waiter !== null) {
        const waiter = state.waiter;
        state.waiter = null;
        waiter.resolve(message.value);
        return;
      }
      if (
        state.queue.length >= limits.maxQueuedMessages ||
        state.queuedBytes + message.size > limits.maxQueuedBytes
      ) {
        abort(state, null);
        socket.close(1009, "Unread message queue full");
        return;
      }
      state.queue.push(message);
      state.queuedBytes += message.size;
    });
    socket.on("close", () => finish(state));
    socket.on("error", (error) => abort(state, error));
  }

  next() {
    const state = socketStates.get(this);
    if (state.queue.length > 0) {
      const message = state.queue.shift();
      state.queuedBytes -= message.size;
      return Promise.resolve(message.value);
    }
    if (state.finished) return Promise.resolve(null);
    if (state.waiter !== null) {
      return Promise.reject(new Error("Only one WebSocket next call may wait at a time"));
    }
    return new Promise((resolve, reject) => {
      state.waiter = { resolve, reject };
    });
  }

  send(message) {
    const state = socketStates.get(this);
    if (state.finished || state.socket.readyState !== OPEN) {
      return Promise.reject(new Error("WebSocket is closed"));
    }
    const size = messageSize(message);
    if (size > state.limits.maxMessageBytes) {
      return Promise.reject(new RangeError("WebSocket message exceeds maxMessageBytes"));
    }
    if (state.pendingSendBytes + size > state.limits.maxPendingSendBytes) {
      return Promise.reject(new RangeError("WebSocket pending sends exceed maxPendingSendBytes"));
    }
    const output = typeof message === "string" ? message : new Uint8Array(message);
    state.pendingSendBytes += size;
    return new Promise((resolve, reject) => {
      state.socket.send(output, { binary: typeof message !== "string" }, (error) => {
        state.pendingSendBytes -= size;
        if (error) reject(error);
        else resolve();
      });
    });
  }

  close(code = 1000, reason = "") {
    const state = socketStates.get(this);
    integer(code, 1000, 4999, "WebSocket close code");
    if (typeof reason !== "string" || Buffer.byteLength(reason, "utf8") > 123) {
      return Promise.reject(new RangeError("WebSocket close reason cannot exceed 123 UTF-8 bytes"));
    }
    if (state.finished) return Promise.resolve();
    if (state.closePromise === null) {
      state.closePromise = new Promise((resolve) => state.socket.once("close", resolve));
      state.socket.close(code, reason);
    }
    return state.closePromise;
  }
}

function responseOf(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("A backend handler must return an HTTP response record");
  }
  integer(value.status, 100, 599, "response status");
  return value;
}

function failureOf(error, request, fallbackStatus = 500) {
  const status = Number.isSafeInteger(error?.statusCode) ? error.statusCode : fallbackStatus;
  return {
    status,
    code: typeof error?.code === "string" ? error.code : "InternalError",
    message: error instanceof Error ? error.message : "The request could not be completed",
    method: request.method,
    path: request.url,
  };
}

export class FastifyBackend {
  constructor(app, options, failureHandler) {
    this.app = app;
    this.options = options;
    this.failureHandler = failureHandler;
    this.sessions = new Set();
  }

  route(method, path, handler) {
    this.app.route({
      method,
      url: path,
      handler: async (request, reply) => {
        const response = responseOf(await handler({
          method: request.method,
          path: request.url,
          requestId: String(request.id),
          body: request.body ?? null,
        }));
        return reply.code(response.status).send(response.json);
      },
    });
  }

  websocket(path, handler) {
    this.app.get(path, { websocket: true }, (socket) => {
      if (this.sessions.size >= this.options.maxConnections) {
        socket.close(1013, "Server busy");
        return;
      }
      const connection = new FastifySocket(socket, this.options);
      this.sessions.add(connection);
      socket.once("close", () => this.sessions.delete(connection));
      Promise.resolve(handler(connection)).catch((error) => {
        this.app.log.error({ err: error }, "websocket.handler.failed");
        return connection.close(1011, "Handler failed");
      });
    });
  }

  async listen(host, port) {
    integer(port, 0, 65_535, "port");
    await this.app.listen({ host, port });
    const address = this.app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Fastify did not publish a TCP address");
    }
    return { host, port: address.port };
  }

  async inject(method, path, body) {
    const request = { method, url: path };
    if (body !== null) {
      request.payload = body;
      request.headers = { "content-type": "application/json" };
    }
    const response = await this.app.inject(request);
    let json;
    try {
      json = response.json();
    } catch {
      json = response.body;
    }
    return { status: response.statusCode, json };
  }

  async close() {
    await Promise.allSettled(
      Array.from(this.sessions, (connection) => connection.close(1001, "Server stopping")),
    );
    await this.app.close();
  }

  info(message, context) {
    if (context === null) this.app.log.info(message);
    else this.app.log.info(context, message);
  }

  warn(message, context) {
    if (context === null) this.app.log.warn(message);
    else this.app.log.warn(context, message);
  }

  error(message, context) {
    if (context === null) this.app.log.error(message);
    else this.app.log.error(context, message);
  }
}

export async function createFastifyBackend(value, failureHandler) {
  const options = optionsOf(value);
  const app = Fastify({ logger: options.logger, bodyLimit: options.bodyLimit });
  await app.register(websocket, {
    options: {
      maxPayload: options.maxMessageBytes,
      perMessageDeflate: false,
      clientTracking: true,
    },
  });
  const backend = new FastifyBackend(app, options, failureHandler);

  const sendFailure = async (failure, reply) => {
    try {
      const response = responseOf(await failureHandler(failure));
      return reply.code(response.status).send(response.json);
    } catch (error) {
      app.log.error({ err: error }, "framework.failure-handler.failed");
      return reply.code(500).send({
        error: "InternalError",
        message: "The request could not be completed",
      });
    }
  };

  app.setNotFoundHandler((request, reply) => sendFailure({
    status: 404,
    code: "RouteNotFound",
    message: `No route matches ${request.method} ${request.url}`,
    method: request.method,
    path: request.url,
  }, reply));
  app.setErrorHandler((error, request, reply) => sendFailure(failureOf(error, request), reply));
  return backend;
}
