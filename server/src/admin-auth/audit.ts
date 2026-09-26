/**
 * One structured line per admin write attempt (method other than GET/HEAD/OPTIONS on
 * /api/v1/admin/*), including denied attempts. Identity only: never a header, token, session
 * or request body.
 */
export type AdminAuditEntry = {
  readonly service: 'arco-giwa-api';
  readonly event: 'admin.write';
  readonly at: string;
  readonly scope: 'vault' | 'stocks';
  readonly method: string;
  readonly route: string;
  readonly params: Readonly<Record<string, string>>;
  readonly statusCode: number;
  readonly operatorId: string | null;
  readonly wallet: string | null;
  readonly via: 'session' | 'legacy-token' | null;
};

export type AdminAuditSink = (entry: AdminAuditEntry) => void;

export const consoleAdminAudit: AdminAuditSink = entry => {
  console.log(JSON.stringify(entry));
};

/** Route params as plain strings (ids from the URL path; bounded by Fastify's maxParamLength). */
export function auditParams(params: unknown): Record<string, string> {
  if (params === null || typeof params !== 'object') return {};
  return Object.fromEntries(Object.entries(params as Record<string, unknown>).map(([key, value]) => [key, String(value)]));
}
