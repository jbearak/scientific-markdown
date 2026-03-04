import { describe, it, expect } from 'bun:test';
import fc from 'fast-check';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	getOutputBasePath,
	getOutputConflictMessage,
	getOutputConflictScenario,
	isSymlink,
	getSymlinkConflictMessage,
	getDocxSymlinkConflictMessage,
} from './output-conflicts';

describe('output conflict helpers', () => {
	it('detects conflict scenario correctly', () => {
		expect(getOutputConflictScenario(false, false)).toBeNull();
		expect(getOutputConflictScenario(true, false)).toBe('md');
		expect(getOutputConflictScenario(false, true)).toBe('bib');
		expect(getOutputConflictScenario(true, true)).toBe('both');
	});

	it('builds a markdown-only conflict message', () => {
		const msg = getOutputConflictMessage('/tmp/article', 'md');
		expect(msg).toContain('"article.md"');
		expect(msg).toContain('already exists in this folder');
		expect(msg).not.toContain('article.bib');
	});

	it('builds a bib-only conflict message', () => {
		const msg = getOutputConflictMessage('/tmp/article', 'bib');
		expect(msg).toContain('"article.bib"');
		expect(msg).toContain('already exists in this folder');
		expect(msg).not.toContain('article.md');
	});

	it('builds a both-files conflict message', () => {
		const msg = getOutputConflictMessage('/tmp/article', 'both');
		expect(msg).toContain('"article.md"');
		expect(msg).toContain('"article.bib"');
		expect(msg).toContain('already exist in this folder');
	});

	it('extracts filename from Windows-style backslash paths', () => {
		const msg = getOutputConflictMessage('C:\\Users\\foo\\article', 'md');
		expect(msg).toContain('"article.md"');
		expect(msg).not.toContain('C:\\');
	});

	it('derives base path from a single selected output name', () => {
		expect(getOutputBasePath('/tmp/new-name.md')).toBe('/tmp/new-name');
		expect(getOutputBasePath('/tmp/new-name')).toBe('/tmp/new-name');
		expect(getOutputBasePath('/tmp/NEW-NAME.MD')).toBe('/tmp/NEW-NAME');
	});

	it('property: (false, false) is always null; any true input is non-null', () => {
		fc.assert(
			fc.property(fc.boolean(), fc.boolean(), (md, bib) => {
				const result = getOutputConflictScenario(md, bib);
				if (!md && !bib) {
					expect(result).toBeNull();
				} else {
					expect(result).not.toBeNull();
				}
			}),
			{ numRuns: 100 }
		);
	});

	it('property: getOutputBasePath stripping .md is idempotent', () => {
		fc.assert(
			fc.property(fc.string(), (path) => {
				const once = getOutputBasePath(path);
				const twice = getOutputBasePath(once);
				expect(twice).toBe(once);
			}),
			{ numRuns: 200 }
		);
	});
});

describe('isSymlink', () => {
	it('returns false for a regular file', async () => {
		const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'symlink-test-'));
		const filePath = path.join(tmpDir, 'regular.txt');
		await fs.promises.writeFile(filePath, 'hello');
		try {
			expect(await isSymlink(filePath)).toBe(false);
		} finally {
			await fs.promises.rm(tmpDir, { recursive: true });
		}
	});

	it('returns true for a symlink', async () => {
		const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'symlink-test-'));
		const targetPath = path.join(tmpDir, 'target.txt');
		const linkPath = path.join(tmpDir, 'link.txt');
		await fs.promises.writeFile(targetPath, 'hello');
		await fs.promises.symlink(targetPath, linkPath);
		try {
			expect(await isSymlink(linkPath)).toBe(true);
		} finally {
			await fs.promises.rm(tmpDir, { recursive: true });
		}
	});

	it('returns false for a non-existent path', async () => {
		expect(await isSymlink('/tmp/nonexistent-path-' + Date.now())).toBe(false);
	});
});

describe('symlink conflict messages', () => {
	it('builds symlink message for md-only conflict', () => {
		const msg = getSymlinkConflictMessage('/tmp/article', 'md', ['md']);
		expect(msg).toContain('"article.md"');
		expect(msg).toContain('is a symlink');
		expect(msg).toContain('Replace the symlink target');
	});

	it('builds symlink message for bib-only conflict', () => {
		const msg = getSymlinkConflictMessage('/tmp/article', 'bib', ['bib']);
		expect(msg).toContain('"article.bib"');
		expect(msg).toContain('is a symlink');
	});

	it('builds symlink message for both-files conflict with both symlinks', () => {
		const msg = getSymlinkConflictMessage('/tmp/article', 'both', ['md', 'bib']);
		expect(msg).toContain('"article.md"');
		expect(msg).toContain('"article.bib"');
		expect(msg).toContain('are symlinks');
	});

	it('builds symlink message for both-files conflict with only md symlink', () => {
		const msg = getSymlinkConflictMessage('/tmp/article', 'both', ['md']);
		expect(msg).toContain('"article.md" is a symlink');
	});

	it('builds docx symlink conflict message', () => {
		const msg = getDocxSymlinkConflictMessage('/tmp/article');
		expect(msg).toContain('"article.docx"');
		expect(msg).toContain('is a symlink');
		expect(msg).toContain('Replace the symlink target');
	});

	it('extracts filename from Windows-style paths in symlink messages', () => {
		const msg = getDocxSymlinkConflictMessage('C:\\Users\\foo\\article');
		expect(msg).toContain('"article.docx"');
		expect(msg).not.toContain('C:\\');
	});
});
