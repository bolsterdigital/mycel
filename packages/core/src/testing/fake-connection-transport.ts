// Only a test adapter: production must install a reviewed transport explicitly, never this fake.
import type { ConnectionTransport } from '../connections/dispatch.js';
import type { ConnectionIntent } from '../connections/intents.js';
export class FakeConnectionTransport implements ConnectionTransport {
  readonly dispatched: ConnectionIntent[] = [];
  readonly reconciled: ConnectionIntent[] = [];
  result: 'succeeded' | 'pre_send' | 'unknown' = 'succeeded';
  lookup: 'succeeded' | 'absent' | 'unknown' = 'unknown';
  async dispatch({ intent }: Parameters<ConnectionTransport['dispatch']>[0]) {
    this.dispatched.push(structuredClone(intent));
    return this.result;
  }
  async reconcile({ intent }: Parameters<NonNullable<ConnectionTransport['reconcile']>>[0]) {
    this.reconciled.push(structuredClone(intent));
    return this.lookup;
  }
}
