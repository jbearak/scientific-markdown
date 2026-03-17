import { join, isAbsolute } from 'path';
import { normalizeBibPath } from './frontmatter';

export function bibliographyCandidatePaths(
  bibliography: string,
  mdDir: string,
  workspaceRoot?: string,
): string[] {
  const bibFile = normalizeBibPath(bibliography);
  if (isAbsolute(bibFile)) {
    return [bibFile];
  }

  const candidates = [join(mdDir, bibFile)];
  if (workspaceRoot) {
    const workspacePath = join(workspaceRoot, bibFile);
    if (!candidates.includes(workspacePath)) candidates.push(workspacePath);
  }
  return candidates;
}

export async function resolveExistingBibliographyPath(
  bibliography: string,
  mdDir: string,
  fileExists: (path: string) => Promise<boolean>,
  workspaceRoot?: string,
): Promise<string | undefined> {
  for (const candidate of bibliographyCandidatePaths(bibliography, mdDir, workspaceRoot)) {
    if (await fileExists(candidate)) return candidate;
  }
  return undefined;
}

export function defaultBibliographyWritePath(
  bibliography: string,
  mdDir: string,
): string {
  const bibFile = normalizeBibPath(bibliography);
  return isAbsolute(bibFile) ? bibFile : join(mdDir, bibFile);
}

export function resolveBibliographyWritePath(
  bibliography: string,
  mdDir: string,
  resolvedExistingPath?: string,
): string {
  return resolvedExistingPath ?? defaultBibliographyWritePath(bibliography, mdDir);
}

export async function resolveBibliographyWritePathForOutput(
  bibliography: string,
  mdDir: string,
  fileExists: (path: string) => Promise<boolean>,
  workspaceRoot?: string,
): Promise<string> {
  const resolvedExistingPath = await resolveExistingBibliographyPath(
    bibliography,
    mdDir,
    fileExists,
    workspaceRoot,
  );
  return resolveBibliographyWritePath(bibliography, mdDir, resolvedExistingPath);
}
