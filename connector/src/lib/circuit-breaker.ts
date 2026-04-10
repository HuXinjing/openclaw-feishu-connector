/**
 * Circuit Breaker implementation for resilient gateway calls.
 * States: closed (normal) → open (failing) → half-open (testing)
 */
export interface CircuitBreakerOptions {
  name: string;
  timeout: number;        // operation timeout in ms
  errorThreshold: number; // failures before opening circuit
  resetTimeout: number;  // wait time before half-open in ms
}

export class CircuitBreaker {
  private failures = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private lastFailureTime = 0;

  constructor(private opts: CircuitBreakerOptions) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime > this.opts.resetTimeout) {
        this.state = 'half-open';
      } else {
        throw new Error(`[CircuitBreaker:${this.opts.name}] Circuit is OPEN`);
      }
    }

    try {
      const result = await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), this.opts.timeout)
        ),
      ]);
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess() {
    this.failures = 0;
    this.state = 'closed';
  }

  private onFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.failures >= this.opts.errorThreshold) {
      this.state = 'open';
      console.warn(`[CircuitBreaker:${this.opts.name}] Circuit OPENED after ${this.failures} failures`);
    }
  }

  getState(): 'closed' | 'open' | 'half-open' {
    return this.state;
  }

  getFailureCount(): number {
    return this.failures;
  }
}
