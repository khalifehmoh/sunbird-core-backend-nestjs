/**
 * Active role sources for a user ($1 = user_id).
 * Direct assignments of ACTIVE roles, plus roles inherited from ACTIVE groups.
 * Used by login JWT claims and the admin effective-permissions listing.
 */
export const ACTIVE_ROLE_SOURCES_SQL = `
SELECT ur.role_id AS role_id, 'DIRECT'::text AS source
  FROM core.user_roles ur
  JOIN core.roles r
    ON r.role_id = ur.role_id
   AND r.is_deleted = false
   AND r.status = 'ACTIVE'
 WHERE ur.user_id = $1
   AND ur.is_deleted = false
UNION ALL
SELECT gr.role_id, 'GROUP'::text
  FROM core.group_members gm
  JOIN core.groups g
    ON g.group_id = gm.group_id
   AND g.is_deleted = false
   AND g.status = 'ACTIVE'
  JOIN core.group_roles gr
    ON gr.group_id = gm.group_id
   AND gr.is_deleted = false
  JOIN core.roles r
    ON r.role_id = gr.role_id
   AND r.is_deleted = false
   AND r.status = 'ACTIVE'
 WHERE gm.user_id = $1
   AND gm.is_deleted = false
`;
