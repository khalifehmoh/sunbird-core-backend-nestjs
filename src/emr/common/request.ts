import type { Request } from 'express';
import type { User } from '../../database/entities/user.entity';

export type AuthenticatedRequest = Request & { user: User };
