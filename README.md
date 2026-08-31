# Sunbird Core Backend — NestJS

Behavior-compatible NestJS migration of the sibling Spring Boot application.
It implements auth registration/login and tenant CRUD against the existing
PostgreSQL `core` schema. Flyway remains the schema authority and TypeORM
schema synchronization is disabled.

## Sunbird setup

Requirements: Node.js 22, npm, PostgreSQL 15+, and Flyway (or Docker Compose).

1. Copy `.env.example` to `.env` and replace all secrets.
2. Run `npm ci`.
3. Recreate the schema and demo data (no Docker required):
   - If PostgreSQL is already running with `DB_*` from `.env`, run `npm run db:setup`.
   - On a blank server, run `scripts/bootstrap-postgres.sql` as a superuser (or set `DB_ADMIN_PASSWORD` in `.env`) then `npm run db:setup`.
   - `npm run db:migrate` applies `db/migration` only; `npm run db:seed` loads `db/seed`. Pass `--reseed` to replace demo rows.
   - `npm run db:dump` refreshes the committed demo snapshot from the current database.
   - `npm run migration:migrate` still runs Flyway via Docker Compose if you prefer that path.
4. Run `npm run start:dev`.

The default API port is 8080. OpenAPI JSON is at `/api-docs`, Swagger UI is at
`/swagger-ui.html`, and health is at `/api/v1/health`.

Session JSON already returns live `permissions[]`. API 403 checks by
`permission_code` are still open — see
[`docs/permissions-followup.md`](./docs/permissions-followup.md).

`npm run docker:up` builds and starts PostgreSQL, Flyway, and the API. Verify
with `npm run lint`, `npm test`, `npm run test:e2e`, and `npm run build`.

## Authentication cookies

Register and login set `access_token` and `refresh_token` as HttpOnly cookies;
tokens are never returned in JSON. Send browser requests with credentials
enabled (`credentials: 'include'` in `fetch`, or `withCredentials: true` in
Axios). Use `POST /api/v1/auth/refresh` to rotate both cookies and
`POST /api/v1/auth/logout` to revoke and clear them. Refresh-token hashes are
stored in `core.refresh_sessions`; rotation atomically revokes the previous
token so it cannot be reused.

The main-branch authentication behavior is also supported:

- `rememberMe` extends refresh-cookie lifetime to 30 days.
- Five failed logins lock an account for 30 minutes.
- `GET /api/v1/auth/session` returns the current session profile.
- `PUT /api/v1/auth/change-password` enforces password complexity, invalidates
  all sessions, and clears cookies.
- JWTs contain the current tenant, role assignments, and permissions.
- Login, logout, failed-login, and password-change events are audited.

Local HTTP development uses `COOKIE_SECURE=false`. Production HTTPS should use
`COOKIE_SECURE=true`. The default `SameSite=lax` setting mitigates cross-site
requests; deployments that require `SameSite=none` must add explicit CSRF
protection before enabling it.

## Compatibility and cutover

- The original routes and `/api/v1` prefix are preserved; refresh and logout
  routes are added for cookie lifecycle management.
- Existing Flyway-managed databases can be reused without conversion.
- Tenant list returns an array with no query parameters and a paged envelope
  when any paging/filter parameter is supplied.
- Tenant deletion is soft.
- Tenant routes require the access-token cookie and intentionally have no role
  gate.

For cutover, deploy against a staging copy of the existing database, run the
contract tests, switch traffic at the load balancer, and retain Spring for
rollback. Avoid concurrent writes from both services until validated.

## NestJS framework reference

<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ npm install
```

## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ npm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
