import * as fs from 'fs';

// Implementation note: Before writing ${base}.md / ${base}.bib, detect pre-existing
// targets and prompt with overwrite/rename/cancel to prevent silent data loss.
// When the existing file is a symlink, we offer "Replace Target" (write through
// the link) vs "Replace Symlink" (unlink first, then write a regular file).
export type OutputConflictScenario = 'md' | 'bib' | 'both';

export function getOutputConflictScenario(
	mdExists: boolean,
	bibExists: boolean
): OutputConflictScenario | null {
	if (mdExists && bibExists) {
		return 'both';
	}
	if (mdExists) {
		return 'md';
	}
	if (bibExists) {
		return 'bib';
	}
	return null;
}

export function getOutputConflictMessage(
	basePath: string,
	scenario: OutputConflictScenario
): string {
	const name = basePath.split(/[/\\]/).pop()!;
	if (scenario === 'both') {
		return `"${name}.md" and "${name}.bib" already exist in this folder. Replace them or save with a new name?`;
	}
	if (scenario === 'md') {
		return `"${name}.md" already exists in this folder. Replace it or save with a new name?`;
	}
	return `"${name}.bib" already exists in this folder. Replace it or save with a new name?`;
}

export function getOutputBasePath(selectedPath: string): string {
	return selectedPath.replace(/\.md$/i, '');
}

export async function isSymlink(fsPath: string): Promise<boolean> {
	try {
		const stat = await fs.promises.lstat(fsPath);
		return stat.isSymbolicLink();
	} catch {
		return false;
	}
}

export function getSymlinkConflictMessage(
	basePath: string,
	scenario: OutputConflictScenario,
	symlinkFiles: ('md' | 'bib')[]
): string {
	const name = basePath.split(/[/\\]/).pop()!;
	const symlinkLabel = symlinkFiles.length === 1
		? '"' + name + '.' + symlinkFiles[0] + '" is a symlink'
		: '"' + name + '.md" and "' + name + '.bib" are symlinks';
	if (scenario === 'both') {
		return '"' + name + '.md" and "' + name + '.bib" already exist (' + symlinkLabel + '). Replace the symlink target, replace the symlink with a regular file, or save with a new name?';
	}
	const ext = scenario;
	return '"' + name + '.' + ext + '" already exists and is a symlink. Replace the symlink target, replace the symlink with a regular file, or save with a new name?';
}

export function getDocxSymlinkConflictMessage(basePath: string): string {
	const name = basePath.split(/[/\\]/).pop()!;
	return '"' + name + '.docx" already exists and is a symlink. Replace the symlink target, replace the symlink with a regular file, or save with a new name?';
}
