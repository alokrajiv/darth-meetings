import 'server-only';
import postgres from 'postgres';
import { config } from '@/config';
import { DB_POOL_CONFIG } from '@/lib/constants/database';

// Second Postgres handle pointing at the `darth_plagueis` database on the
// same instance. We reuse the meeting_whisperer role, which has been granted
// SELECT on darth_plagueis.ppl + darth_plagueis.emails. This connection is
// READ-ONLY by design — don't add write operations.

const ENABLE_HOT_RELOAD_DB_REUSE = process.env.HOT_RELOAD_DB_REUSE !== 'false';

declare global {
  // eslint-disable-next-line no-var
  var __mwHotReloadPlagueisConnection: ReturnType<typeof postgres> | undefined;
}

function createPlagueisConnection() {
  console.log('[plagueis-db] initialising read-only handle', {
    host: config.database.host,
    database: 'darth_plagueis',
  });

  return postgres({
    host: config.database.host,
    port: config.database.port,
    database: 'darth_plagueis',
    username: config.database.user,
    password: config.database.password,
    max: 4,
    idle_timeout: DB_POOL_CONFIG.idleTimeoutMillis / 1000,
    max_lifetime: 60 * 5,
    connect_timeout: DB_POOL_CONFIG.connectionTimeoutMillis / 1000,
    ssl: config.database.ssl.enabled,
    onnotice: () => {},
  });
}

export const plagueisSql =
  (ENABLE_HOT_RELOAD_DB_REUSE && global.__mwHotReloadPlagueisConnection) ||
  createPlagueisConnection();

if (ENABLE_HOT_RELOAD_DB_REUSE && config.env.isDevelopment) {
  global.__mwHotReloadPlagueisConnection = plagueisSql;
}
