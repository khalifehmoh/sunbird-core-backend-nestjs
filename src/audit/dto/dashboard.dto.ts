export class ActivityByDayDto {
  date!: string;
  count!: number;
}

export class DashboardStatsDto {
  tenantCount!: number;
  userCount!: number;
  activeSessionCount!: number;
  auditCount24h!: number;
  activityByDay!: ActivityByDayDto[];
}
