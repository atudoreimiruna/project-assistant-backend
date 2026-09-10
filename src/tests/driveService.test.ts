import { buildRevisionActivity, DriveRevision } from '../services/driveService';

describe('buildRevisionActivity', () => {
	const teamId = 'team-123';
	const file = {
		id: 'file-abc',
		name: 'Sprint Plan',
		mimeType: 'application/vnd.google-apps.document',
		webViewLink: 'https://docs.google.com/document/d/file-abc/edit',
	};

	it('attributes the edit to a known team member and tags it as a document activity', () => {
		const revision: DriveRevision = {
			id: 'rev-1',
			modifiedTime: '2026-02-10T09:30:00.000Z',
			lastModifyingUser: { displayName: 'Ana Pop', emailAddress: 'Ana@Example.com' },
		};

		const activity = buildRevisionActivity(teamId, file, revision, new Set(['ana@example.com']));

		expect(activity.type).toBe('document');
		expect(activity.studentEmail).toBe('ana@example.com');
		expect(activity.description).toBe('Doc "Sprint Plan" edited by Ana Pop');
		expect(activity.timestamp).toEqual(new Date('2026-02-10T09:30:00.000Z'));
		expect(activity.metadata).toMatchObject({
			driveRevisionId: 'file-abc:rev-1',
			driveFileId: 'file-abc',
			mimeType: file.mimeType,
			url: file.webViewLink,
		});
	});

	it('leaves studentEmail undefined when the editor is not on the roster', () => {
		const revision: DriveRevision = {
			id: 'rev-2',
			modifiedTime: '2026-02-11T09:30:00.000Z',
			lastModifyingUser: { displayName: 'Outside Collaborator', emailAddress: 'outsider@example.com' },
		};

		const activity = buildRevisionActivity(teamId, file, revision, new Set(['ana@example.com']));

		expect(activity.studentEmail).toBeUndefined();
		expect(activity.description).toBe('Doc "Sprint Plan" edited by Outside Collaborator');
	});

	it('falls back to the email, then "someone", when no display name is present', () => {
		const withEmailOnly = buildRevisionActivity(
			teamId,
			file,
			{ id: 'rev-3', modifiedTime: '2026-02-12T00:00:00.000Z', lastModifyingUser: { emailAddress: 'x@example.com' } },
			new Set(),
		);
		expect(withEmailOnly.description).toBe('Doc "Sprint Plan" edited by x@example.com');

		const withNoAuthor = buildRevisionActivity(
			teamId,
			file,
			{ id: 'rev-4', modifiedTime: '2026-02-13T00:00:00.000Z' },
			new Set(),
		);
		expect(withNoAuthor.description).toBe('Doc "Sprint Plan" edited by someone');
	});

	it('gives each revision of the same file a distinct dedupe key', () => {
		const a = buildRevisionActivity(
			teamId,
			file,
			{ id: 'rev-1', modifiedTime: '2026-02-10T09:30:00.000Z' },
			new Set(),
		);
		const b = buildRevisionActivity(
			teamId,
			file,
			{ id: 'rev-2', modifiedTime: '2026-02-11T09:30:00.000Z' },
			new Set(),
		);
		expect(a.metadata.driveRevisionId).not.toBe(b.metadata.driveRevisionId);
	});
});
