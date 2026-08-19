export class AsyncMutex {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
}
