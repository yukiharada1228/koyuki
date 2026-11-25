/** Trusted request metadata supplied by the host, never copied from command payloads. */
export interface AuditIdentity {
  readonly actorId: string;
  readonly operationId: string;
  readonly definitionVersion: string;
  readonly occurredAt: string;
}
export interface AuditChange {
  readonly targetType: string;
  readonly targetId: string;
  readonly beforeVersion: number | null;
  readonly afterVersion: number;
}
export interface AuditRecord extends AuditIdentity, AuditChange {
  readonly schema: 'koyuki.audit.v1';
  readonly operation: string;
}
/** Select only explicit metadata; no domain payload, error, token or ambient clock. */
export function auditRecord(identity: AuditIdentity, operation: string, change: AuditChange): AuditRecord {
  const record: AuditRecord = {
    schema: 'koyuki.audit.v1', operation,
    actorId: identity.actorId, operationId: identity.operationId,
    definitionVersion: identity.definitionVersion, occurredAt: identity.occurredAt,
    targetType: change.targetType, targetId: change.targetId,
    beforeVersion: change.beforeVersion, afterVersion: change.afterVersion,
  };
  const text = [record.operation, record.actorId, record.operationId, record.definitionVersion, record.targetType, record.targetId];
  if (text.some(value => typeof value !== 'string' || value.length === 0 || value.length > 200 || value.trim() !== value) ||
      typeof record.occurredAt !== 'string' || !Number.isFinite(Date.parse(record.occurredAt)) || new Date(record.occurredAt).toISOString() !== record.occurredAt ||
      !Number.isSafeInteger(record.afterVersion) || record.afterVersion < 1 ||
      (record.beforeVersion !== null && (!Number.isSafeInteger(record.beforeVersion) || record.beforeVersion < 1 || record.afterVersion !== record.beforeVersion + 1))) {
    throw new TypeError('Invalid audit metadata');
  }
  return Object.freeze(record);
}
