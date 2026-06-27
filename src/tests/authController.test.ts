import request from 'supertest';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import routes from '../routes';
import Teacher from '../models/Teacher';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7';

const app = express();
app.use(express.json());
app.use('/api', routes);

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
	mongoServer = await MongoMemoryServer.create();
	await mongoose.connect(mongoServer.getUri(), { dbName: 'test' });
});

afterAll(async () => {
	await mongoose.disconnect();
	await mongoServer.stop();
});

afterEach(async () => {
	await Teacher.deleteMany({});
});

describe('POST /api/auth/register', () => {
	it('registers a new teacher and returns a token', async () => {
		const res = await request(app).post('/api/auth/register').send({
			name: 'Theo',
			email: 'theo@example.com',
			password: 'secret123',
		});

		if (res.status !== 201) {
			console.error('REGISTER FAIL', res.status, res.body);
		}

		expect(res.status).toBe(201);
		expect(res.body).toHaveProperty('token');
		expect(res.body.teacher).toMatchObject({
			name: 'Theo',
			email: 'theo@example.com',
		});
	});

	it('returns 400 when email already exists', async () => {
		await Teacher.create({
			name: 'Existing',
			email: 'theo@example.com',
			password: 'secret123',
		});

		const res = await request(app).post('/api/auth/register').send({
			name: 'Theo',
			email: 'theo@example.com',
			password: 'secret123',
		});

		expect(res.status).toBe(400);
		expect(res.body.message).toBe('Email already in use');
	});
});
