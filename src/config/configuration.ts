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
    clientId: process.env.MEDPLUM_CLIENT_ID,
    clientSecret: process.env.MEDPLUM_CLIENT_SECRET,
    projectId: process.env.MEDPLUM_PROJECT_ID,
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
  // Required together only when the FHIR gateway is switched on, so the
  // existing dev setup keeps working without any Medplum config present.
  MEDPLUM_CLIENT_ID: Joi.string().uuid().when('MEDPLUM_ENABLED', {
    is: true,
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  MEDPLUM_CLIENT_SECRET: Joi.string().when('MEDPLUM_ENABLED', {
    is: true,
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  MEDPLUM_PROJECT_ID: Joi.string().uuid().when('MEDPLUM_ENABLED', {
    is: true,
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
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
