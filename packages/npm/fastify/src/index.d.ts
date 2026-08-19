export interface NativeBackendOptions {
  logger: boolean;
  bodyLimit: number;
  maxMessageBytes: number;
  maxQueuedMessages: number;
  maxQueuedBytes: number;
  maxPendingSendBytes: number;
  maxConnections: number;
}

export interface NativeRequest {
  method: string;
  path: string;
  requestId: string;
  body: unknown;
}

export interface NativeResponse {
  status: number;
  json: unknown;
}

export interface NativeFailure {
  status: number;
  code: string;
  message: string;
  method: string;
  path: string;
}

export interface NativeAddress {
  host: string;
  port: number;
}

export interface NativeInjectResponse {
  status: number;
  json: unknown;
}

export type NativeHttpHandler = (request: NativeRequest) => Promise<NativeResponse>;
export type NativeFailureHandler = (failure: NativeFailure) => Promise<NativeResponse>;
export type NativeSocketHandler = (connection: FastifySocket) => Promise<void>;

export class FastifySocket {
  next(): Promise<unknown>;
  send(message: unknown): Promise<void>;
  close(code?: number, reason?: string): Promise<void>;
}

export class FastifyBackend {
  route(method: string, path: string, handler: NativeHttpHandler): void;
  websocket(path: string, handler: NativeSocketHandler): void;
  listen(host: string, port: number): Promise<NativeAddress>;
  inject(method: string, path: string, body: unknown): Promise<NativeInjectResponse>;
  close(): Promise<void>;
  info(message: string, context: unknown): void;
  warn(message: string, context: unknown): void;
  error(message: string, context: unknown): void;
}

export function createFastifyBackend(
  options: NativeBackendOptions,
  failureHandler: NativeFailureHandler,
): Promise<FastifyBackend>;
