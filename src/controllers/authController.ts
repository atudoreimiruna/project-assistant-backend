import { Request, Response } from 'express';
import { errorMessage } from '../utils/errors';
import crypto from 'crypto';
import jwt, { Secret, SignOptions } from 'jsonwebtoken';
import Teacher from '../models/Teacher';
import { sendPasswordResetEmail } from '../services/emailService';

const signToken = (id: string, email: string): string => {
	const secret: Secret = process.env.JWT_SECRET as Secret;
	const expiresIn: any = process.env.JWT_EXPIRES_IN ? `${process.env.JWT_EXPIRES_IN}d` : '7d';

	const options: SignOptions = { expiresIn };

	return jwt.sign({ id, email }, secret, options);
};

export const register = async (req: Request, res: Response): Promise<void> => {
	try {
		const { name, email, password } = req.body;

		const existing = await Teacher.findOne({ email });
		if (existing) {
			res.status(400).json({ message: 'Email already in use' });
			return;
		}

		const teacher = await Teacher.create({ name, email, password });
		const token = signToken(teacher.id, teacher.email);

		res.status(201).json({ token, teacher: { id: teacher.id, name, email } });
	} catch (error) {
		res.status(500).json({ message: 'Server error', error: errorMessage(error) });
	}
};

export const login = async (req: Request, res: Response): Promise<void> => {
	try {
		const { email, password } = req.body;

		const teacher = await Teacher.findOne({ email });
		if (!teacher || !(await teacher.comparePassword(password))) {
			res.status(401).json({ message: 'Invalid email or password' });
			return;
		}

		const token = signToken(teacher.id, teacher.email);
		res.json({ token, teacher: { id: teacher.id, name: teacher.name, email } });
	} catch (error) {
		res.status(500).json({ message: 'Server error', error: errorMessage(error) });
	}
};

export const forgotPassword = async (req: Request, res: Response): Promise<void> => {
	try {
		const { email } = req.body;

		const teacher = await Teacher.findOne({ email });
		// Always respond with success to avoid leaking which emails are registered
		if (!teacher) {
			res.json({ message: 'If that email is registered, a reset link has been sent.' });
			return;
		}

		const rawToken = crypto.randomBytes(32).toString('hex');
		const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

		teacher.resetPasswordToken = hashedToken;
		teacher.resetPasswordExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
		await teacher.save();

		await sendPasswordResetEmail(teacher.email, rawToken);

		res.json({ message: 'If that email is registered, a reset link has been sent.' });
	} catch (error) {
		res.status(500).json({ message: 'Server error', error: errorMessage(error) });
	}
};

export const resetPassword = async (req: Request, res: Response): Promise<void> => {
	try {
		const { token } = req.params;
		const { password } = req.body;

		const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

		const teacher = await Teacher.findOne({
			resetPasswordToken: hashedToken,
			resetPasswordExpires: { $gt: new Date() },
		});

		if (!teacher) {
			res.status(400).json({ message: 'Token is invalid or has expired.' });
			return;
		}

		teacher.password = password;
		teacher.resetPasswordToken = undefined;
		teacher.resetPasswordExpires = undefined;
		await teacher.save();

		const jwtToken = signToken(teacher.id, teacher.email);
		res.json({ message: 'Password reset successful.', token: jwtToken });
	} catch (error) {
		res.status(500).json({ message: 'Server error', error: errorMessage(error) });
	}
};
