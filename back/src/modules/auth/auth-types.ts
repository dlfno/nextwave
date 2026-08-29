export type UserRole = 'HUMAN' | 'MERCHANT_OPERATOR' | 'AUDITOR' | 'ADMIN';

export interface AuthContext {
  user: {
    id: string;
    email: string;
    displayName: string;
    role: UserRole;
  };
  session: {
    id: string;
    csrfHash: Buffer;
    expiresAt: Date;
    reauthenticatedAt: Date;
  };
}
