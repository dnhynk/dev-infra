import { createHash } from 'node:crypto';

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex');
}

/** Durable issue identity. Only the digest is persisted; private inputs are never returned. */
export function discoveryIssueHash(category: string, ...privateParts: readonly string[]): string {
  return digest([category, ...privateParts]);
}

/** Short correlation reference suitable for structured degraded facts and logs. */
export function redactedEntityRef(kind: string, privateIdentity: string): string {
  return digest([kind, privateIdentity]).slice(0, 12);
}
