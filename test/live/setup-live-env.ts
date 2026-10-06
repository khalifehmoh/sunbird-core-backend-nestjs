import { config } from 'dotenv';
import { join } from 'node:path';

// The live suites run against the developer stack described by `.env`
// (Postgres, Medplum). Values already in the environment win over `.env`.
config({ path: join(process.cwd(), '.env'), quiet: true });

// The in-process app must not start a second BullMQ worker next to the dev server.
process.env.EVENTS_ENABLED = 'false';
