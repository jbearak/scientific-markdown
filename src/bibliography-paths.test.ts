import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  bibliographyCandidatePaths,
  resolveExistingBibliographyPath,
  defaultBibliographyWritePath,
  resolveBibliographyWritePath,
} from './bibliography-paths';

describe('bibliography path helpers', () => {
  test('relative bibliography prefers markdown directory then workspace root', () => {
    const candidates = bibliographyCandidatePaths('refs/library', '/repo/docs/paper', '/repo');
    expect(candidates).toEqual([
      '/repo/docs/paper/refs/library.bib',
      '/repo/refs/library.bib',
    ]);
  });

  test('absolute bibliography path is not prefixed with workspace root', () => {
    const candidates = bibliographyCandidatePaths('/shared/library', '/repo/docs/paper', '/repo');
    expect(candidates).toEqual(['/shared/library.bib']);
  });

  test('resolveExistingBibliographyPath finds workspace-root fallback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mm-bib-paths-'));
    try {
      const mdDir = join(root, 'docs');
      const wsRoot = join(root, 'workspace');
      mkdirSync(mdDir, { recursive: true });
      mkdirSync(join(wsRoot, 'refs'), { recursive: true });
      const bibPath = join(wsRoot, 'refs', 'library.bib');
      writeFileSync(bibPath, '@article{key,}\n');

      const resolved = await resolveExistingBibliographyPath(
        'refs/library',
        mdDir,
        async (p) => Bun.file(p).exists(),
        wsRoot,
      );
      expect(resolved).toBe(bibPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('defaultBibliographyWritePath creates relative paths under markdown directory', () => {
    expect(defaultBibliographyWritePath('refs/library', '/repo/docs/paper'))
      .toBe('/repo/docs/paper/refs/library.bib');
  });

  test('resolveBibliographyWritePath prefers the resolved existing file', () => {
    expect(resolveBibliographyWritePath(
      'refs/library',
      '/repo/docs/paper',
      '/repo/refs/library.bib',
    )).toBe('/repo/refs/library.bib');
  });
});
