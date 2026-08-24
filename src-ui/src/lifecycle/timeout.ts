/**
 * withTimeout — race a promise against a deadline.
 * On timeout, calls onTimeout (if provided) and rejects.
 * The original promise is NOT cancelled (no cancellation in JS promises),
 * but the caller can use AbortController for actual cancellation.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutP = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`timeout after ${ms}ms`));
    }, ms);
  });
  // executor 同步运行，timer 在 race 决议前必然已赋值；守卫仅为满足类型
  return Promise.race([promise, timeoutP]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
