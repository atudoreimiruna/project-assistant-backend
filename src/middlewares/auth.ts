import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { JwtPayload } from '../types';

export interface AuthRequest extends Request {
	teacher?: JwtPayload;
}

export const protect = (req: AuthRequest, res: Response, next: NextFunction): void => {
	const authHeader = req.headers.authorization;

	if (!authHeader || !authHeader.startsWith('Bearer ')) {
		res.status(401).json({ message: 'Not authorized, no token' });
		return;
	}

	const token = authHeader.split(' ')[1];

	try {
		const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as JwtPayload;
		req.teacher = decoded;
		next();
	} catch {
		res.status(401).json({ message: 'Not authorized, invalid token' });
	}
};
