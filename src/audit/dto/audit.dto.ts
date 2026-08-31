export class AuditLogResponseDto {
  auditId!: string;
  createdAt!: string;
  userId!: string | null;
  username!: string | null;
  userFullName!: string | null;
  actionType!: string;
  entityType!: string;
  entityId!: string | null;
  entityName!: string | null;
  tenantId!: string | null;
  tenantName!: string | null;
  ipAddress!: string | null;
  userAgent!: string | null;
  success!: boolean;
  errorMessage!: string | null;
  oldValue!: Record<string, unknown> | null;
  newValue!: Record<string, unknown> | null;
  failedLoginAttempts!: number | null;
  accountLockedUntil!: string | null;
  targetUserStatus!: string | null;
}

export class FailedLoginSummaryDto {
  totalFailed!: number;
  uniqueIps!: number;
  lockedAccounts!: number;
  flaggedIps!: string[];
}

export class PagedResponseDto<T> {
  content!: T[];
  page!: number;
  size!: number;
  totalElements!: number;
  totalPages!: number;
  last!: boolean;
}
