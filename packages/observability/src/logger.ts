// One JSON object per line on stdout (stderr for the MCP server, whose stdout is the protocol),
// with the context of the request or job. Our own ~60 lines instead of pino (ADR 008 rule 1):
// pino redacts by path, and what we must redact is a value (an address inside an error message,
// ADR 019 rule 8). Every string is scrubbed and keys that name a person's data are dropped.

import { scrubText, type LogFields, type Logger } from '@mycel/core';
import { currentContext } from './context.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Dropped, not scrubbed: these hold a person's data or a credential by their very name. */
const DENY = new Set([
  'email',
  'to',
  'recipient',
  'address',
  'input',
  'payload',
  'props',
  'body',
  'authorization',
  'cookie',
]);
/** The envelope of every line; fields cannot overwrite it. */
const RESERVED = new Set(['time', 'level', 'msg', 'service']);

export interface LoggerOptions {
  service: 'api' | 'web' | 'worker' | 'mcp' | (string & {});
  level?: LogLevel | undefined;
  /** One finished line, without the newline. Default: stdout. */
  write?: ((line: string) => void) | undefined;
  now?: (() => Date) | undefined;
}

export function createLogger(options: LoggerOptions, base: LogFields = {}): Logger {
  const min = LOG_LEVELS.indexOf(options.level ?? 'info');
  const write = options.write ?? ((line: string) => void process.stdout.write(line + '\n'));
  const now = options.now ?? (() => new Date());
  const emit = (level: LogLevel, message: string, fields: LogFields = {}) => {
    if (LOG_LEVELS.indexOf(level) < min) return;
    const line: Record<string, unknown> = {
      time: now().toISOString(),
      level,
      msg: scrubText(message),
      service: options.service,
    };
    for (const [key, value] of Object.entries({ ...currentContext(), ...base, ...fields })) {
      if (value === undefined || RESERVED.has(key) || DENY.has(key.toLowerCase())) continue;
      line[key] = typeof value === 'string' ? scrubText(value) : value;
    }
    write(JSON.stringify(line));
  };
  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (fields) => createLogger(options, { ...base, ...fields }),
  };
}

/** `LOG_LEVEL` from the environment; an unknown value is `info`, never a crash at startup. */
export function logLevelOf(value: string | undefined): LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value ?? '') ? (value as LogLevel) : 'info';
}
