import { Mutex } from "async-mutex";

export class AsyncMutex {
  #mutex = new Mutex();

  runExclusive(operation) {
    if (typeof operation !== "function") {
      throw new TypeError("AsyncMutex operation must be a function");
    }
    return this.#mutex.runExclusive(operation);
  }
}
