/**
 * T-006: Identity Types
 */

export interface UnifiedUser {
  id: string;
  linkedSurfaces: Record<string, string>; // surfaceId → surfaceUserId
  defaultSurface: string;
  linkedAt: Record<string, string>; // surfaceId → ISO-8601
  createdAt: string;
}

export interface LinkCode {
  code: string;
  issuedBy: string; // "surfaceId:surfaceUserId"
  issuedAt: string;
  expiresAt: string;
  claimed: boolean;
}

// Error types
export class LinkCodeExpiredError extends Error {
  constructor() { super("Link code has expired"); this.name = "LinkCodeExpiredError"; }
}
export class LinkCodeNotFoundError extends Error {
  constructor() { super("Link code not found"); this.name = "LinkCodeNotFoundError"; }
}
export class SameSurfaceError extends Error {
  constructor() { super("Cannot link the same surface to itself"); this.name = "SameSurfaceError"; }
}
export class SurfaceNotLinkedError extends Error {
  constructor(surface: string) { super(`Surface "${surface}" is not linked to this user`); this.name = "SurfaceNotLinkedError"; }
}
export class LastSurfaceError extends Error {
  constructor() { super("Cannot unlink the last remaining surface"); this.name = "LastSurfaceError"; }
}
export class MaxCodesError extends Error {
  constructor() { super("Maximum active link codes reached (3)"); this.name = "MaxCodesError"; }
}
