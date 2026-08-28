import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Stub the Claude call so the graph can be exercised without an API key.
const createMock = jest.fn();
jest.mock('../agents/shared', () => {
	const actual = jest.requireActual('../agents/shared');
	return { ...actual, anthropic: { messages: { create: (...args: unknown[]) => createMock(...args) } } };
});

import Team from '../models/Team';
import TeamReport from '../models/TeamReport';
import { runTeamReportGraph } from '../agents/graphs/teamReportGraph';

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
	await Team.deleteMany({});
	await TeamReport.deleteMany({});
	createMock.mockReset();
});

async function seedTeam() {
	return Team.create({
		courseId: new mongoose.Types.ObjectId(),
		name: 'Team Alpha',
		students: [{ name: 'Ana', email: 'ana@uni.edu' }],
		milestones: [],
	});
}

const textResponse = (text: string) => ({ content: [{ type: 'text', text }] });

describe('teamReportGraph', () => {
	it('short-circuits to the cached report without calling Claude', async () => {
		const team = await seedTeam();
		await TeamReport.create({
			teamId: team.id,
			generatedAt: new Date(),
			activityCount: 0,
			summary: 'cached summary',
			status: 'ON_TRACK',
			concerns: [],
			recommendations: [],
			studentBreakdown: [],
		});

		const report = await runTeamReportGraph(team.id);

		expect(report.summary).toBe('cached summary');
		expect(createMock).not.toHaveBeenCalled();
	});

	it('generates and persists a report when there is no cache', async () => {
		const team = await seedTeam();
		createMock.mockResolvedValue(
			textResponse(
				JSON.stringify({
					summary: 'Steady progress.',
					status: 'ON_TRACK',
					concerns: ['none'],
					recommendations: ['keep going'],
				}),
			),
		);

		const report = await runTeamReportGraph(team.id);

		expect(createMock).toHaveBeenCalledTimes(1);
		expect(report.status).toBe('ON_TRACK');
		expect(report.summary).toBe('Steady progress.');
		await expect(TeamReport.countDocuments({ teamId: team.id })).resolves.toBe(1);
	});

	it('strips markdown fences around the JSON payload', async () => {
		const team = await seedTeam();
		createMock.mockResolvedValue(
			textResponse('```json\n{"summary":"Fenced.","status":"BLOCKED","concerns":[],"recommendations":[]}\n```'),
		);

		const report = await runTeamReportGraph(team.id);

		expect(report.status).toBe('BLOCKED');
		expect(report.summary).toBe('Fenced.');
	});

	it('does not poison the cache when the response will not parse', async () => {
		const team = await seedTeam();
		createMock.mockResolvedValue(textResponse('I am afraid I cannot do that.'));

		const report = await runTeamReportGraph(team.id);

		// Caller still gets a degraded report...
		expect(report.status).toBe('AT_RISK');
		expect(report.concerns).toContain('Could not parse structured response from AI.');
		// ...but nothing was written, so the next request retries instead of
		// serving this for the full 24h TTL.
		await expect(TeamReport.countDocuments({ teamId: team.id })).resolves.toBe(0);
	});

	it('falls back to AT_RISK for an unrecognised status value', async () => {
		const team = await seedTeam();
		createMock.mockResolvedValue(
			textResponse('{"summary":"Odd.","status":"EXPLODED","concerns":[],"recommendations":[]}'),
		);

		const report = await runTeamReportGraph(team.id);

		expect(report.status).toBe('AT_RISK');
	});
});
