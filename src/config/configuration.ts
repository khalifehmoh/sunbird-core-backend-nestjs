import * as Joi from 'joi';

export const configuration = () => ({
  port: Number(process.env.PORT ?? 8080),
  database: {
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    name: process.env.DB_NAME ?? 'sunbird_core_db',
    username: process.env.DB_USERNAME ?? 'sunbird_app',
    password: process.env.DB_PASSWORD,
  },
  jwt: {
    secret: process.env.JWT_SECRET,
    accessExpiryMs: Number(process.env.JWT_ACCESS_TOKEN_EXPIRY_MS ?? 900000),
    refreshExpiryMs: Number(
      process.env.JWT_REFRESH_TOKEN_EXPIRY_MS ?? 604800000,
    ),
    rememberMeRefreshExpiryMs: Number(
      process.env.JWT_REMEMBER_ME_REFRESH_TOKEN_EXPIRY_MS ?? 2592000000,
    ),
  },
  cookie: {
    secure:
      process.env.COOKIE_SECURE !== undefined
        ? process.env.COOKIE_SECURE === 'true'
        : process.env.NODE_ENV === 'production',
    sameSite: process.env.COOKIE_SAME_SITE ?? 'lax',
    domain: process.env.COOKIE_DOMAIN || undefined,
  },
  medplum: {
    enabled: process.env.MEDPLUM_ENABLED === 'true',
    baseUrl: process.env.MEDPLUM_BASE_URL ?? 'http://localhost:8103/',
    tenantsFile: process.env.MEDPLUM_TENANTS_FILE ?? '.medplum/tenants.json',
  },
  integration: {
    // Shared secret for the machine-to-machine HL7 endpoint. Unset disables it.
    apiKey: process.env.INTEGRATION_API_KEY || undefined,
  },
  events: {
    enabled: process.env.EVENTS_ENABLED === 'true',
    subscriptionSecret:
      process.env.EVENTS_SUBSCRIPTION_SECRET ??
      'local-subscription-secret-change-me',
    redis: {
      host: process.env.EVENTS_REDIS_HOST ?? 'localhost',
      port: Number(process.env.EVENTS_REDIS_PORT ?? 6380),
      password:
        process.env.EVENTS_REDIS_PASSWORD ??
        process.env.MEDPLUM_REDIS_PASSWORD ??
        'medplum_local_password',
    },
  },
});

export const environmentSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().port().default(8080),
  DB_HOST: Joi.string().default('localhost'),
  DB_PORT: Joi.number().port().default(5432),
  DB_NAME: Joi.string().default('sunbird_core_db'),
  DB_USERNAME: Joi.string().default('sunbird_app'),
  DB_PASSWORD: Joi.string().required(),
  JWT_SECRET: Joi.string().min(32).required(),
  JWT_ACCESS_TOKEN_EXPIRY_MS: Joi.number().integer().positive().default(900000),
  JWT_REFRESH_TOKEN_EXPIRY_MS: Joi.number()
    .integer()
    .positive()
    .default(604800000),
  JWT_REMEMBER_ME_REFRESH_TOKEN_EXPIRY_MS: Joi.number()
    .integer()
    .positive()
    .default(2592000000),
  COOKIE_SECURE: Joi.boolean(),
  COOKIE_SAME_SITE: Joi.string().valid('strict', 'lax', 'none').default('lax'),
  COOKIE_DOMAIN: Joi.string().allow('').optional(),
  CORS_ALLOWED_ORIGINS: Joi.string().default(
    [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:3000',
      'http://127.0.0.1:3000',
    ].join(','),
  ),
  MEDPLUM_ENABLED: Joi.boolean().default(false),
  MEDPLUM_BASE_URL: Joi.string().uri().default('http://localhost:8103/'),
  // Written by `npm run medplum:provision`: one Project and service client per
  // tenant, plus each user's ProjectMembership. Read-only for the API.
  MEDPLUM_TENANTS_FILE: Joi.string().default('.medplum/tenants.json'),
  // Lets an integration engine POST HL7 v2 to /emr/integration/inbound.
  // Leave unset to disable that endpoint; staff can still submit messages
  // from the monitor.
  INTEGRATION_API_KEY: Joi.string().min(24).allow('').optional(),
  EVENTS_ENABLED: Joi.boolean().default(false),
  EVENTS_SUBSCRIPTION_SECRET: Joi.string().min(16).when('EVENTS_ENABLED', {
    is: true,
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  EVENTS_REDIS_HOST: Joi.string().default('localhost'),
  EVENTS_REDIS_PORT: Joi.number().port().default(6380),
  EVENTS_REDIS_PASSWORD: Joi.string().optional(),
  MEDPLUM_REDIS_PASSWORD: Joi.string().optional(),
});
