/**
 * Runtime configuration. Every secret comes from environment variables and is
 * never logged or returned to a client.
 */
export interface Config {
  appleId: string;
  appleAppPassword: string;
  caldavUrl: string;
  defaultCalendarName: string;
  timezone: string;
  loginPassphrase: string;
  tokenSecret: string;
}

export const MIN_PASSPHRASE_LENGTH = 16;
export const MIN_TOKEN_SECRET_LENGTH = 32;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    appleId: (env.APPLE_ID ?? '').trim(),
    appleAppPassword: (env.APPLE_APP_PASSWORD ?? '').trim(),
    caldavUrl: (env.CALDAV_URL ?? 'https://caldav.icloud.com').trim(),
    defaultCalendarName: (env.DEFAULT_CALENDAR_NAME ?? 'MCP-project').trim(),
    timezone: (env.TIMEZONE ?? 'Asia/Bangkok').trim(),
    loginPassphrase: env.LOGIN_PASSPHRASE ?? '',
    tokenSecret: env.TOKEN_SECRET ?? '',
  };
}

/** Which parts are usable. Booleans only, so it is safe to show on the status page. */
export function configStatus(cfg: Config) {
  return {
    apple: cfg.appleId.length > 0 && cfg.appleAppPassword.length > 0,
    passphrase: cfg.loginPassphrase.length >= MIN_PASSPHRASE_LENGTH,
    tokenSecret: cfg.tokenSecret.length >= MIN_TOKEN_SECRET_LENGTH,
  };
}

export function authReady(cfg: Config): boolean {
  const s = configStatus(cfg);
  return s.passphrase && s.tokenSecret;
}
