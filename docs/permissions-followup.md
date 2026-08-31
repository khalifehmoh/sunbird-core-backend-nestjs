# Permissions follow-up (backend 403 guards)

Frontend-first slice is **done**. This note is the locked product decisions plus the remaining NestJS work: enforce the same codes on API routes with **403**.

Blueprint `@PreAuthorize` / `USER:READ` strings in [`../sunbird-frontend/docs/admin.md`](../../sunbird-frontend/docs/admin.md) are **docs-only**. Implement in NestJS (this repo). Do not add a `USER:READ` ↔ `USER_MGMT_READ` alias map.

## Status

| Layer | State |
|-------|--------|
| Session `permissions[]` on login, refresh, `GET /auth/session` | Done — `AuthService.resolvePermissions` via `ACTIVE_ROLE_SOURCES_SQL` |
| JWT already embeds `permissions` | Done — `buildSession` claims |
| Frontend `usePermissions` + admin nav / `/admin` gate | Done — `sunbird-frontend` |
| API 403 by `permission_code` | **Not started** — JWT auth only; controllers check tenant scope via `isPlatformAdmin`, not permission codes |
| Seed missing admin-console codes (`TENANT:READ`, `ROLE:READ`, …) | **Not started** — live catalog is incomplete |

## Locked decisions

1. **DB is source of truth.** Guard with the exact `core.permissions.permission_code` string. No alias map.
2. **Effective access** = active direct roles **plus** roles from **active** groups (`ACTIVE_ROLE_SOURCES_SQL` in [`src/auth/effective-access.query.ts`](../src/auth/effective-access.query.ts)).
3. **Platform admin** = role codes include `SUPER_ADMIN` or `ADMIN` after **splitting comma-separated** JWT `role`. **Not** `TENANT_ADMIN`. Used for **scope** (all tenants, global roles), not “may call any admin API”.
4. **SUPER_ADMIN / ADMIN bypass** permission checks (same as frontend `usePermissions`). Everyone else, including `TENANT_ADMIN`, needs an exact match on the permission list.
5. **Admin-console entry** (if the API ever needs an equivalent of `/admin`) = platform admin **or** any code in the admin-console set below. **Do not** treat “any permission” as admin. **Do not** treat `SETTINGS_READ` as admin (Abdullah has it and must stay out of the console).
6. HttpOnly JWT cannot drive the React hook; the JSON session body is the frontend contract. Keep `permissions[]` on login / refresh / session.

## Live catalog (inventory via `GET /permissions`, ~200 rows)

**Exists today**

- `USER_MGMT_CREATE` / `DELETE` / `EXPORT` / `READ` / `UPDATE`
- `APPOINTMENT_MGMT_*`, `BILLING_*`, `LABORATORY_*`, `PATIENT_MGMT_*`, `PHARMACY_*`, `REPORTS_*`
- `SETTINGS_READ` / `SETTINGS_UPDATE`
- `CUSTOM1:CREATEEE` (typo in dump — do not “fix” in guards)

**Does not exist** (frontend still checks these; only SUPER_ADMIN UI bypass sees those pages)

`TENANT:*`, `BRANCH:*`, `GROUP:*`, `ROLE:*`, `MODULE:*`, `PERMISSION:*`, `AUDIT:*`, `SESSION:*`, `ASSIGN_ROLE`, `REVOKE_ROLE`, `GRANT_PERMISSION`, `REVOKE_PERMISSION`, `CONFIG:*`

Until those rows are seeded, a non–platform-admin with only `USER_MGMT_*` must **403** on tenant/role/module/audit APIs.

### Blueprint → DB (user management only)

| Blueprint (`admin.md`) | Guard with |
|------------------------|------------|
| `USER:READ` | `USER_MGMT_READ` |
| `USER:CREATE` | `USER_MGMT_CREATE` |
| `USER:UPDATE` | `USER_MGMT_UPDATE` |
| `USER:DELETE` | `USER_MGMT_DELETE` |
| `USER:EXPORT` | `USER_MGMT_EXPORT` |

Leave other blueprint strings as-is **after they exist in `core.permissions`**. Do not invent `USER_MGMT`-style renames for them.

### Admin-console set (must match frontend)

See [`sunbird-frontend/src/constants/permissions.ts`](../../sunbird-frontend/src/constants/permissions.ts) `ADMIN_CONSOLE_PERMISSIONS`:

`USER_MGMT_READ|CREATE|UPDATE|DELETE|EXPORT`, `TENANT:READ`, `BRANCH:READ`, `GROUP:READ`, `ROLE:READ`, `MODULE:READ`, `PERMISSION:READ`, `AUDIT:READ`, `SESSION:READ`

Exclude `SETTINGS_READ`.

## What the frontend already does

- Persist `permissions` on the auth slice; refresh/`setUser` copies the array.
- `isPlatformAdmin` splits comma-separated roles (`CUSTOM222,SUPER_ADMIN` works).
- `usePermissions(code)` → platform admin **or** `permissions.includes(code)`.
- `/admin` + dashboard link: `useCanAccessAdmin` (platform admin **or** any admin-console code).
- Nav hides items without the matching code; empty nested groups hide.
- User pages check `USER_MGMT_*`, not `USER:*`.

Without API guards, a user can still call `GET /api/v1/users` with a cookie if they guess the URL. That is this follow-up.

## Suggested NestJS approach

Do **not** scaffold Spring `@PreAuthorize`. Follow existing auth: `JwtAuthGuard` + decorators.

1. **Attach permissions on the request user** in [`src/auth/jwt.strategy.ts`](../src/auth/jwt.strategy.ts). Claims already include `permissions`; `validate` currently copies only `payload.role`. Either:
   - copy `payload.permissions` onto `request.user` (fast; token can be stale until refresh), or
   - re-resolve via `resolvePermissions(userId)` (accurate after role/group changes; extra query).
   Prefer **JWT claims for the hot path**, and rely on existing session invalidation / refresh when roles change. If role-permission mutations already bump user cache tags on the frontend, confirm whether refresh sessions are revoked on those mutations; if not, flag it.

2. **`@RequirePermissions('USER_MGMT_READ')` decorator** + `PermissionsGuard** that:
   - skips when `isPlatformAdmin(user.role)` (split commas — already in [`src/auth/user-role.enum.ts`](../src/auth/user-role.enum.ts));
   - else requires **all** listed codes (AND) unless a route explicitly needs ANY (document that).
   - returns **403** (not 401) when authenticated but missing the code.

3. **Wire controllers** to blueprint operations, using DB codes:

   | Area | Typical codes |
   |------|----------------|
   | Users list/detail/sessions | `USER_MGMT_READ` |
   | User create / update / delete / status / reset password | `USER_MGMT_CREATE` / `UPDATE` / `DELETE` |
   | Assign / revoke user roles | `ASSIGN_ROLE` / `REVOKE_ROLE` (seed first) |
   | Tenants / branches / groups / roles / modules / permissions / audit / sessions | matching `*:READ|CREATE|UPDATE|DELETE` once seeded |

   Keep existing `tenantScope(user)` / `isPlatformAdmin` for **data scope**. Permission guards are **orthogonal**: a `TENANT_ADMIN` with `USER_MGMT_READ` still sees only their tenant.

4. **Tests:** unit-test the guard (platform bypass, comma-separated `SUPER_ADMIN`, missing code → 403, Abdullah-shaped list with `SETTINGS_READ` + lab codes → 403 on `/users`). Cookie fixtures for `AuthResponseDto` must keep `permissions: []`.

5. **Optional seed migration** (separate PR if product agrees): insert the missing admin-console codes so tenant/role/module pages can work for non–SUPER_ADMIN operators. Do not rename existing `USER_MGMT_*` rows to `USER:*`.

## Verify

- Platform admin (`SUPER_ADMIN`): all existing admin APIs still 200 (bypass).
- User with only `USER_MGMT_READ`: `GET /users` 200 (tenant-scoped); `GET /tenants`, `/roles`, `/audit` **403**.
- User like Abdullah (`LABORATORY_*`, `SETTINGS_READ`, no `USER_MGMT_*`): **403** on `/users` and other admin-console routes; clinical APIs (when they exist) still allowed.
- `TENANT_ADMIN` is **not** a permission bypass; only tenant scope.

Do not commit `LOCAL_CREDENTIALS.md`.

## Prompt to resume

```text
Implement NestJS API 403 permission guards per @docs/permissions-followup.md.
Use live DB permission_code values (USER_MGMT_READ not USER:READ).
SUPER_ADMIN/ADMIN bypass after splitting comma-separated JWT role; not TENANT_ADMIN.
Do not treat SETTINGS_READ as admin-console access.
Attach JWT permissions in jwt.strategy; add @RequirePermissions + PermissionsGuard.
Keep tenantScope as-is. No Spring/Java.
```
