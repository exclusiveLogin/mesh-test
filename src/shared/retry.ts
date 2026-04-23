export interface RetryOptions {
  retries: number;
  initialDelayMs: number;
  factor: number;
}

export const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(
  task: () => Promise<T>,
  options: RetryOptions,
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void
): Promise<T> {
  let currentDelay = options.initialDelayMs;
  let attempt = 0;

  for (;;) {
    try {
      return await task();
    } catch (error) {
      attempt += 1;
      if (attempt > options.retries) {
        throw error;
      }
      onRetry?.(attempt, currentDelay, error);
      await sleep(currentDelay);
      currentDelay *= options.factor;
    }
  }
}
