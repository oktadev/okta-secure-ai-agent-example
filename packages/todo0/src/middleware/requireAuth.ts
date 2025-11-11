import { Request, Response, NextFunction } from 'express';

export function createRequireAuth() {
  return async function requireAuth(req: Request, res: Response, next: NextFunction) {
    // 1. Check for session-based authentication
    if (req.session && (req.session as any).access_token) {
      console.log('✓ Session-based authentication found');
      return next();
    } else {
      return res.status(401).json({ error: 'Missing or invalid session' });
    }
  };
}

declare global {
  namespace Express {
    interface Request {
      user?: any;
    }
  }
}
