/** Shared logger. Every module uses this so verbosity is changed in one place. */

export const logger = {
  info: (...args: unknown[]) => console.log(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
  debug: (...args: unknown[]) => {
    if (process.env.ROUTER_DEBUG) console.debug(...args);
  },
};