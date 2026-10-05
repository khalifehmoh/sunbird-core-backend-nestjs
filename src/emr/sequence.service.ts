import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/** Per-tenant counters (MRN, order numbers) that never hand out a value twice. */
@Injectable()
export class SequenceService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Atomically increments and returns the counter. The upsert takes a row
   * lock, so concurrent callers (and concurrent API instances) each get a
   * distinct value. A value is consumed even if the caller later fails, so
   * numbers can skip but never repeat.
   */
  async next(tenantId: string, name: string): Promise<number> {
    const rows: unknown = await this.dataSource.query(
      `INSERT INTO core.emr_sequences (tenant_id, name, value)
       VALUES ($1, $2, 1)
       ON CONFLICT (tenant_id, name)
       DO UPDATE SET value = core.emr_sequences.value + 1
       RETURNING value`,
      [tenantId, name],
    );
    const row = (Array.isArray(rows) ? rows[0] : undefined) as
      { value: string | number } | undefined;
    if (!row) throw new Error(`Sequence ${name} returned no value`);
    return Number(row.value);
  }
}
