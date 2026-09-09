/**
 * Google Drive service — manages folder permissions for team members.
 *
 * Requires environment variables:
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL  — the service account email
 *   GOOGLE_SERVICE_ACCOUNT_KEY    — the private key (PEM, newlines as \n)
 *
 * The service account must have been granted editor/organizer access to
 * every Drive folder that will be shared with students (domain-wide
 * delegation is NOT required; just pre-share the folder with the SA first).
 */

import { createSign } from 'crypto';
import Team from '../models/Team';
import ActivityLog from '../models/ActivityLog';
import { ContributorPreview } from './githubService';

// ── JWT / token helpers ────────────────────────────────────────────────────

const SCOPES = 'https://www.googleapis.com/auth/drive';

const base64url = (buf: Buffer | string): string =>
	Buffer.from(buf)
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');

const makeJwt = (): string => {
	const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
	const key = (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').replace(/\\n/g, '\n');
	if (!email || !key) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_SERVICE_ACCOUNT_KEY');

	const now = Math.floor(Date.now() / 1000);
	const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
	const payload = base64url(
		JSON.stringify({ iss: email, scope: SCOPES, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }),
	);
	const sign = createSign('RSA-SHA256');
	sign.update(`${header}.${payload}`);
	const sig = base64url(sign.sign(key));
	return `${header}.${payload}.${sig}`;
};

let cachedToken: { token: string; expiresAt: number } | null = null;

const getAccessToken = async (): Promise<string> => {
	if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;

	const jwt = makeJwt();
	const res = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
	});
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error(`Google token error: ${res.status} - ${JSON.stringify(body)}`);
	}
	const data = (await res.json()) as { access_token: string; expires_in: number };
	cachedToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
	return cachedToken.token;
};

// ── Extract file/folder ID from a Drive URL or raw ID ─────────────────────

/**
 * Extracts the Google file/folder ID from any Google URL or a raw ID.
 *
 * Supported patterns:
 *   Drive folder  — https://drive.google.com/drive/folders/<id>
 *   Drive open    — https://drive.google.com/open?id=<id>
 *   Docs          — https://docs.google.com/document/d/<id>/...
 *   Sheets        — https://docs.google.com/spreadsheets/d/<id>/...
 *   Slides        — https://docs.google.com/presentation/d/<id>/...
 *   Forms         — https://docs.google.com/forms/d/<id>/...
 *   Raw ID        — any 25–44 char alphanumeric/dash/underscore string
 */
export const parseGoogleFileId = (input: string): string | null => {
	if (!input) return null;
	try {
		const u = new URL(input);
		// /d/<id>/ — covers Docs, Sheets, Slides, Forms
		const dMatch = u.pathname.match(/\/d\/([a-zA-Z0-9_-]+)/);
		if (dMatch) return dMatch[1];
		// /folders/<id>
		const folderMatch = u.pathname.match(/\/folders\/([a-zA-Z0-9_-]+)/);
		if (folderMatch) return folderMatch[1];
		// ?id=<id>
		const idParam = u.searchParams.get('id');
		if (idParam) return idParam;
	} catch {
		// not a URL — treat as raw ID
		if (/^[a-zA-Z0-9_-]{25,}$/.test(input)) return input;
	}
	return null;
};

/** @deprecated use parseGoogleFileId */
export const parseFolderId = parseGoogleFileId;

// ── Permission helpers ─────────────────────────────────────────────────────

const driveBase = 'https://www.googleapis.com/drive/v3';

export const addDriveMember = async (folderId: string, email: string): Promise<void> => {
	const token = await getAccessToken();
	const res = await fetch(`${driveBase}/files/${folderId}/permissions`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ type: 'user', role: 'writer', emailAddress: email }),
	});
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error(`Drive add member failed for ${email}: ${res.status} - ${JSON.stringify(body)}`);
	}
};

export const removeDriveMember = async (folderId: string, email: string): Promise<void> => {
	const token = await getAccessToken();

	// First find the permissionId for this email
	const listRes = await fetch(`${driveBase}/files/${folderId}/permissions?fields=permissions(id,emailAddress)`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!listRes.ok) {
		const body = await listRes.json().catch(() => ({}));
		throw new Error(`Drive list permissions failed: ${listRes.status} - ${JSON.stringify(body)}`);
	}
	const { permissions } = (await listRes.json()) as { permissions: { id: string; emailAddress: string }[] };
	const perm = permissions?.find((p) => p.emailAddress?.toLowerCase() === email.toLowerCase());
	if (!perm) return; // already removed

	const delRes = await fetch(`${driveBase}/files/${folderId}/permissions/${perm.id}`, {
		method: 'DELETE',
		headers: { Authorization: `Bearer ${token}` },
	});
	if (delRes.status !== 204 && !delRes.ok) {
		const body = await delRes.json().catch(() => ({}));
		throw new Error(`Drive remove member failed for ${email}: ${delRes.status} - ${JSON.stringify(body)}`);
	}
};

interface DriveFile {
	id: string;
	name: string;
	mimeType: string;
	modifiedTime?: string;
	webViewLink?: string;
	lastModifyingUser?: { displayName?: string; emailAddress?: string };
}

const DRIVE_FIELDS = 'id,name,mimeType,modifiedTime,webViewLink,lastModifyingUser(displayName,emailAddress)';

const mimeTypeLabel = (mimeType: string | undefined): string => {
	switch (mimeType) {
		case 'application/vnd.google-apps.document':
			return 'Doc';
		case 'application/vnd.google-apps.spreadsheet':
			return 'Sheet';
		case 'application/vnd.google-apps.presentation':
			return 'Slides';
		case 'application/vnd.google-apps.form':
			return 'Form';
		case 'application/vnd.google-apps.folder':
			return 'Folder';
		default:
			return 'File';
	}
};

const getDriveFile = async (fileId: string, token: string): Promise<DriveFile | null> => {
	const res = await fetch(`${driveBase}/files/${fileId}?fields=${encodeURIComponent(DRIVE_FIELDS)}`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!res.ok) return null;
	return (await res.json()) as DriveFile;
};

/**
 * The service account can only read a Doc/Sheet/Slides/folder that's been
 * explicitly shared with it — unlike a student's own Drive, it has no
 * standing access to anything. When `getDriveFile` comes back null this is
 * overwhelmingly why, so every caller that can't proceed without the root
 * file should throw this rather than a generic "not found", since a bad
 * link and a missing share look identical from here.
 */
const notSharedWithServiceAccountError = (): Error => {
	const sa = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
	return new Error(
		sa
			? `Could not read this Google document. Share it (Viewer is enough) with ${sa}, then try again.`
			: 'Could not read this Google document — check the link, or that GOOGLE_SERVICE_ACCOUNT_EMAIL is configured on the server.',
	);
};

/**
 * Every non-folder file "in scope" for a team's linked Drive item: just that
 * item if it's a single Doc/Sheet/Slides link, or every direct child if it's
 * a folder link. Shared by the contributor preview and the activity sync so
 * both look at exactly the same set of files.
 */
const listScopedFiles = async (root: DriveFile, rootId: string, token: string): Promise<DriveFile[]> => {
	if (root.mimeType !== 'application/vnd.google-apps.folder') return [root];

	const q = `'${rootId}' in parents and trashed = false`;
	const res = await fetch(
		`${driveBase}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(`files(${DRIVE_FIELDS})`)}&pageSize=100`,
		{ headers: { Authorization: `Bearer ${token}` } },
	);
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error(`Failed to list Drive folder contents: ${res.status} - ${JSON.stringify(body)}`);
	}
	const data = (await res.json()) as { files?: DriveFile[] };
	return (Array.isArray(data.files) ? data.files : []).filter((f) => f.mimeType !== 'application/vnd.google-apps.folder');
};

interface DriveRevisionAuthor {
	displayName?: string;
	emailAddress?: string;
}

export interface DriveRevision {
	id: string;
	modifiedTime: string;
	lastModifyingUser?: DriveRevisionAuthor;
}

const REVISION_FIELDS = 'nextPageToken,revisions(id,modifiedTime,lastModifyingUser(displayName,emailAddress))';

/**
 * Full edit history for one file via the Drive Revisions API — every past
 * save, each with who made it and when, which is what lets us log every
 * collaborator's edits over time instead of only the file's current state.
 *
 * Not every file keeps a revision history (Forms and a few other types
 * don't, and a fresh file may have none yet), so an empty array here means
 * "no history available", not an error — callers should fall back to the
 * file's current lastModifyingUser/modifiedTime instead.
 */
const listFileRevisions = async (fileId: string, token: string): Promise<DriveRevision[]> => {
	const revisions: DriveRevision[] = [];
	let pageToken: string | undefined;
	do {
		const url = new URL(`${driveBase}/files/${fileId}/revisions`);
		url.searchParams.set('fields', REVISION_FIELDS);
		url.searchParams.set('pageSize', '1000');
		if (pageToken) url.searchParams.set('pageToken', pageToken);

		const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
		if (!res.ok) return revisions; // unsupported file type, or no revision history yet
		const data = (await res.json()) as { revisions?: DriveRevision[]; nextPageToken?: string };
		revisions.push(...(data.revisions ?? []));
		pageToken = data.nextPageToken;
	} while (pageToken);
	return revisions;
};

/**
 * Who actually collaborated on the linked document(s), not just who has
 * sharing access. Merges two signals:
 *   - sharing permissions on the linked file/folder ("has access")
 *   - authorship pulled from each file's revision history ("has edited",
 *     with an edit count and the timestamp of their most recent edit)
 * A person can show up from either signal or both; editors are listed first
 * since an actual edit is stronger evidence of collaboration than access.
 */
export const previewDriveContributors = async (teamId: string): Promise<ContributorPreview[]> => {
	const team = await Team.findById(teamId);
	if (!team || !team.googleDriveFolder) return [];

	const folderId = parseGoogleFileId(team.googleDriveFolder);
	if (!folderId) return [];

	const token = await getAccessToken();

	const root = await getDriveFile(folderId, token);
	if (!root) throw notSharedWithServiceAccountError();

	const files = await listScopedFiles(root, folderId, token);

	// Signal 1: who has been granted access to the file/folder.
	const permRes = await fetch(
		`${driveBase}/files/${folderId}/permissions?fields=permissions(emailAddress,displayName,role,type)`,
		{ headers: { Authorization: `Bearer ${token}` } },
	);
	const permissions = permRes.ok
		? (((await permRes.json()) as { permissions?: { emailAddress?: string; displayName?: string; role: string; type: string }[] }).permissions ?? [])
		: [];

	// Signal 2: who actually edited, aggregated across every file in scope.
	const editorStats = new Map<string, { name: string; count: number; lastEditAt: string }>();
	for (const f of files) {
		const revisions = await listFileRevisions(f.id, token);
		for (const r of revisions) {
			const email = r.lastModifyingUser?.emailAddress?.toLowerCase();
			if (!email) continue;
			const name = r.lastModifyingUser?.displayName || email;
			const prev = editorStats.get(email);
			editorStats.set(email, {
				name: prev?.name ?? name,
				count: (prev?.count ?? 0) + 1,
				lastEditAt: prev && prev.lastEditAt > r.modifiedTime ? prev.lastEditAt : r.modifiedTime,
			});
		}
	}

	const existingEmails = new Set(team.students.map((s: any) => (s.email as string).toLowerCase()));
	const existingNames = team.students.map((s: any) => ({ name: (s.name as string).toLowerCase(), display: s.name as string }));
	const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.toLowerCase();

	const byEmail = new Map<string, { name: string; editCount?: number; lastEditAt?: string }>();

	for (const p of permissions) {
		if (p.type !== 'user' || !p.emailAddress) continue;
		if (p.role === 'owner') continue;
		const email = p.emailAddress.toLowerCase();
		if (serviceAccountEmail && email === serviceAccountEmail) continue;
		byEmail.set(email, { name: p.displayName || p.emailAddress });
	}

	for (const [email, stat] of editorStats) {
		if (serviceAccountEmail && email === serviceAccountEmail) continue;
		const existing = byEmail.get(email);
		byEmail.set(email, { name: existing?.name || stat.name, editCount: stat.count, lastEditAt: stat.lastEditAt });
	}

	const previews: ContributorPreview[] = [];
	for (const [email, info] of byEmail) {
		const alreadyMember = existingEmails.has(email);

		let possibleDuplicate: string | undefined;
		if (!alreadyMember) {
			const lowerName = info.name.toLowerCase();
			const match = existingNames.find((e) => e.name === lowerName);
			if (match) possibleDuplicate = match.display;
		}

		previews.push({
			name: info.name,
			email,
			alreadyMember,
			possibleDuplicate,
			hasRealEmail: true,
			editCount: info.editCount,
			lastEditAt: info.lastEditAt,
		});
	}

	// Proven editors first (most edits first), then access-only collaborators.
	previews.sort((a, b) => (b.editCount ?? 0) - (a.editCount ?? 0));

	return previews;
};

export const syncDriveFolder = async (teamId: string): Promise<void> => {
	const team = await Team.findById(teamId);
	if (!team || !team.googleDriveFolder) return;

	const folderId = parseGoogleFileId(team.googleDriveFolder);
	if (!folderId) throw new Error('Invalid Google document/folder URL');

	await Promise.allSettled(
		team.students.map((s: any) => addDriveMember(folderId, s.email)),
	);
};

// ── Activity sync ───────────────────────────────────────────────────────────

interface ScopedDriveFileInfo {
	id: string;
	name: string;
	mimeType: string;
	webViewLink?: string;
}

/**
 * Builds the ActivityLog fields for one past edit of one file, given a
 * revision pulled from listFileRevisions(). Pure and DB-free on purpose —
 * it's the piece worth unit testing (student attribution, description
 * format), separately from the network calls around it.
 */
export const buildRevisionActivity = (
	teamId: string,
	file: ScopedDriveFileInfo,
	revision: DriveRevision,
	existingEmails: Set<string>,
) => {
	const authorEmail = revision.lastModifyingUser?.emailAddress?.toLowerCase();
	const studentEmail = authorEmail && existingEmails.has(authorEmail) ? authorEmail : undefined;
	const authorName = revision.lastModifyingUser?.displayName || authorEmail || 'someone';
	const dedupeKey = `${file.id}:${revision.id}`;

	return {
		teamId,
		type: 'document' as const,
		studentEmail,
		description: `${mimeTypeLabel(file.mimeType)} "${file.name}" edited by ${authorName}`,
		timestamp: new Date(revision.modifiedTime),
		metadata: { driveRevisionId: dedupeKey, driveFileId: file.id, mimeType: file.mimeType, url: file.webViewLink },
	};
};

/**
 * Checks the linked Drive folder (or single Doc/Sheet/Slides link) for new
 * activity and logs each as a 'document' ActivityLog entry — the Drive
 * equivalent of the GitHub commit/PR sync triggered by the team page's
 * "Refresh activity" button.
 *
 * For each file this walks its full revision history (see listFileRevisions)
 * and logs one entry per past edit, attributed to whoever made it — so a
 * team's document activity reads like GitHub's commit history: every
 * collaborator, every time they touched the file. Files that don't expose a
 * revision history (e.g. Forms) fall back to a single entry for their
 * current lastModifyingUser/modifiedTime, same as before this existed.
 */
export const syncDriveActivity = async (teamId: string): Promise<{ filesChecked: number; newActivity: number }> => {
	const team = await Team.findById(teamId);
	if (!team || !team.googleDriveFolder) return { filesChecked: 0, newActivity: 0 };

	const rootId = parseGoogleFileId(team.googleDriveFolder);
	if (!rootId) throw new Error('Invalid Google document/folder URL');

	const token = await getAccessToken();
	const root = await getDriveFile(rootId, token);
	if (!root) throw notSharedWithServiceAccountError();

	const files = await listScopedFiles(root, rootId, token);
	const existingEmails = new Set(team.students.map((s: any) => (s.email as string).toLowerCase()));

	let newActivity = 0;
	for (const f of files) {
		const revisions = await listFileRevisions(f.id, token);

		if (revisions.length > 0) {
			for (const revision of revisions) {
				const dedupeKey = `${f.id}:${revision.id}`;
				const exists = await ActivityLog.findOne({ 'metadata.driveRevisionId': dedupeKey });
				if (exists) continue;

				await ActivityLog.create(buildRevisionActivity(teamId, f, revision, existingEmails));
				newActivity++;
			}
			continue;
		}

		// No revision history for this file — fall back to its current state.
		if (!f.modifiedTime) continue;
		const dedupeKey = `${f.id}:${f.modifiedTime}`;
		const exists = await ActivityLog.findOne({ 'metadata.driveDedupeKey': dedupeKey });
		if (exists) continue;

		const authorEmail = f.lastModifyingUser?.emailAddress?.toLowerCase();
		const studentEmail = authorEmail && existingEmails.has(authorEmail) ? authorEmail : undefined;
		const authorName = f.lastModifyingUser?.displayName || authorEmail || 'someone';

		await ActivityLog.create({
			teamId,
			type: 'document',
			studentEmail,
			description: `${mimeTypeLabel(f.mimeType)} "${f.name}" updated by ${authorName}`,
			timestamp: new Date(f.modifiedTime),
			metadata: { driveDedupeKey: dedupeKey, driveFileId: f.id, mimeType: f.mimeType, url: f.webViewLink },
		});
		newActivity++;
	}

	return { filesChecked: files.length, newActivity };
};

export default { addDriveMember, removeDriveMember, syncDriveFolder, syncDriveActivity, previewDriveContributors, parseFolderId };
