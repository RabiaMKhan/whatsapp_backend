/**
 * Token bucket: holds up to `capacity` tokens and refills `refillPerSecond`.
 * Each event takes one token; with none left the event is refused.
 * Allows short bursts but caps the steady rate. One bucket per socket.
 */
export function createRateLimiter({ capacity, refillPerSecond }: { capacity: number; refillPerSecond: number }) {
  let tokens = capacity;
  let lastRefill = Date.now();

  return {
    take(): boolean {
      const now = Date.now();
      tokens = Math.min(capacity, tokens + ((now - lastRefill) / 1000) * refillPerSecond);
      lastRefill = now;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}
