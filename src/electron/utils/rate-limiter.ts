/**
 * Simple in-memory rate limiter for IPC handlers
 * Prevents abuse by limiting call frequency per channel
 */

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

interface RateLimitConfig {
  maxRequests: number;  // Max requests allowed in the window
  windowMs: number;     // Time window in milliseconds
}

// Default configurations for different handler types
export const RATE_LIMIT_CONFIGS = {
  // Expensive operations (LLM calls, task creation)
  expensive: { maxRequests: 10, windowMs: 60000 },      // 10 per minute
  // Standard operations (most handlers)
  standard: { maxRequests: 60, windowMs: 60000 },       // 60 per minute
  // High-frequency operations (UI updates, status checks)
  frequent: { maxRequests: 300, windowMs: 60000 },      // 300 per minute
  // Very limited (settings save, credential operations)
  limited: { maxRequests: 5, windowMs: 60000 },         // 5 per minute
} as const;

class RateLimiter {
  private limits: Map<string, RateLimitEntry> = new Map();
  private configs: Map<string, RateLimitConfig> = new Map();

  /**
   * Configure rate limit for a specific channel
   */
  configure(channel: string, config: RateLimitConfig): void {
    this.configs.set(channel, config);
  }

  /**
   * Check if request should be allowed
   * Returns true if allowed, false if rate limited
   */
  check(channel: string): boolean {
    const config = this.configs.get(channel) || RATE_LIMIT_CONFIGS.standard;
    const now = Date.now();
    const entry = this.limits.get(channel);

    if (!entry || now >= entry.resetTime) {
      // First request or window expired - start new window
      this.limits.set(channel, {
        count: 1,
        resetTime: now + config.windowMs,
      });
      return true;
    }

    if (entry.count >= config.maxRequests) {
      // Rate limit exceeded
      return false;
    }

    // Increment count
    entry.count++;
    return true;
  }

  /**
   * Get remaining requests for a channel
   */
  getRemaining(channel: string): number {
    const config = this.configs.get(channel) || RATE_LIMIT_CONFIGS.standard;
    const entry = this.limits.get(channel);

    if (!entry || Date.now() >= entry.resetTime) {
      return config.maxRequests;
    }

    return Math.max(0, config.maxRequests - entry.count);
  }

  /**
   * Get time until rate limit resets (in ms)
   */
  getResetTime(channel: string): number {
    const entry = this.limits.get(channel);
    if (!entry) return 0;

    const remaining = entry.resetTime - Date.now();
    return Math.max(0, remaining);
  }

  /**
   * Clear rate limit for a channel (for testing)
   */
  reset(channel: string): void {
    this.limits.delete(channel);
  }

  /**
   * Clear all rate limits
   */
  resetAll(): void {
    this.limits.clear();
  }
}

// Singleton instance
export const rateLimiter = new RateLimiter();

/**
 * Helper to wrap an IPC handler with rate limiting
 */
export function withRateLimit<T extends (...args: any[]) => Promise<any>>(
  channel: string,
  handler: T,
  config: RateLimitConfig = RATE_LIMIT_CONFIGS.standard
): T {
  rateLimiter.configure(channel, config);

  return (async (...args: Parameters<T>): Promise<ReturnType<T>> => {
    if (!rateLimiter.check(channel)) {
      const resetMs = rateLimiter.getResetTime(channel);
      const resetSec = Math.ceil(resetMs / 1000);
      throw new Error(
        `Rate limit exceeded for ${channel}. Try again in ${resetSec} seconds.`
      );
    }
    return handler(...args);
  }) as T;
}
