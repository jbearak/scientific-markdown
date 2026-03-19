import { describe, it, expect } from 'bun:test';
import { scanOrientationDirectives } from './orientation-scan';

describe('scanOrientationDirectives', () => {
  it('returns empty for matched pair', () => {
    const text = '<!-- landscape -->\nContent\n<!-- /landscape -->';
    expect(scanOrientationDirectives(text)).toEqual([]);
  });

  it('detects unclosed open', () => {
    const text = 'Before\n\n<!-- landscape -->\n\nContent';
    const findings = scanOrientationDirectives(text);
    expect(findings.length).toBe(1);
    expect(findings[0].kind).toBe('unclosed');
    expect(findings[0].directiveName).toBe('landscape');
  });

  it('detects orphaned close', () => {
    const text = 'Before\n\n<!-- /portrait -->\n\nAfter';
    const findings = scanOrientationDirectives(text);
    expect(findings.length).toBe(1);
    expect(findings[0].kind).toBe('orphaned');
    expect(findings[0].directiveName).toBe('portrait');
  });

  it('detects nested same-name open', () => {
    const text = '<!-- landscape -->\nP1\n<!-- landscape -->\nP2\n<!-- /landscape -->';
    const findings = scanOrientationDirectives(text);
    expect(findings.length).toBe(1);
    expect(findings[0].kind).toBe('nested');
    expect(findings[0].directiveName).toBe('landscape');
    expect(findings[0].relatedName).toBe('landscape');
  });

  it('detects nested cross-type open (portrait inside landscape)', () => {
    const text = '<!-- landscape -->\n<!-- portrait -->\n<!-- /landscape -->';
    const findings = scanOrientationDirectives(text);
    expect(findings.some(f => f.kind === 'nested' && f.directiveName === 'portrait' && f.relatedName === 'landscape')).toBe(true);
  });

  it('detects crossed close', () => {
    const text = '<!-- landscape -->\n<!-- /portrait -->\n<!-- /landscape -->';
    const findings = scanOrientationDirectives(text);
    expect(findings.some(f => f.kind === 'crossed' && f.directiveName === 'portrait' && f.relatedName === 'landscape')).toBe(true);
  });

  it('skips directives inside fenced code blocks', () => {
    const text = '```\n<!-- landscape -->\n```';
    expect(scanOrientationDirectives(text)).toEqual([]);
  });

  it('returns correct byte offsets', () => {
    const text = 'abc\n<!-- landscape -->';
    const findings = scanOrientationDirectives(text);
    expect(findings.length).toBe(1);
    expect(findings[0].start).toBe(4);
    expect(findings[0].end).toBe(4 + '<!-- landscape -->'.length);
  });

  it('handles multiple independent pairs', () => {
    const text = '<!-- landscape -->\nA\n<!-- /landscape -->\n<!-- portrait -->\nB\n<!-- /portrait -->';
    expect(scanOrientationDirectives(text)).toEqual([]);
  });

  it('enforces single active orientation', () => {
    // landscape open then portrait open — portrait is nested because landscape is active
    const text = '<!-- landscape -->\n<!-- portrait -->\n<!-- /portrait -->\n<!-- /landscape -->';
    const findings = scanOrientationDirectives(text);
    // portrait open is nested, then /portrait is crossed (landscape is still on stack)
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].kind).toBe('nested');
    expect(findings[0].directiveName).toBe('portrait');
  });
});
