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

export const previewDriveContributors = async (teamId: string): Promise<ContributorPreview[]> => {
	const team = await Team.findById(teamId);
	if (!team || !team.googleDriveFolder) return [];

	const folderId = parseGoogleFileId(team.googleDriveFolder);
	if (!folderId) return [];

	const token = await getAccessToken();
	const res = await fetch(
		`${driveBase}/files/${folderId}/permissions?fields=permissions(emailAddress,displayName,role,type)`,
		{ headers: { Authorization: `Bearer ${token}` } },
	);
	if (!res.ok) return [];

	const { permissions } = (await res.json()) as {
		permissions: { emailAddress?: string; displayName?: string; role: string; type: string }[];
	};
	if (!Array.isArray(permissions)) return [];

	const existingEmails = new Set(team.students.map((s: any) => (s.email as string).toLowerCase()));
	const existingNames = team.students.map((s: any) => ({ name: (s.name as string).toLowerCase(), display: s.name as string }));
	const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.toLowerCase();

	const previews: ContributorPreview[] = [];

	for (const p of permissions) {
		if (p.type !== 'user' || !p.emailAddress) continue;
		if (p.role === 'owner') continue;
		if (serviceAccountEmail && p.emailAddress.toLowerCase() === serviceAccountEmail) continue;

		const email = p.emailAddress;
		const name = p.displayName || email;
		const alreadyMember = existingEmails.has(email.toLowerCase());

		let possibleDuplicate: string | undefined;
		if (!alreadyMember) {
			const lowerName = name.toLowerCase();
			const match = existingNames.find((e) => e.name === lowerName);
			if (match) possibleDuplicate = match.display;
		}

		previews.push({ name, email, alreadyMember, possibleDuplicate });
	}

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

export default { addDriveMember, removeDriveMember, syncDriveFolder, previewDriveContributors, parseFolderId };
