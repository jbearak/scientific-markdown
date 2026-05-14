import { describe, test, expect } from 'bun:test';
import { preprocessPanelFences, decodePanelPlaceholder, PANEL_PLACEHOLDER_PREFIX } from './panel-preprocess';

describe('preprocessPanelFences', () => {
  test('converts a basic panel fence to a placeholder', () => {
    const input = '~~~panel type=info\nHello\n~~~';
    const output = preprocessPanelFences(input);
    expect(output).toContain(PANEL_PLACEHOLDER_PREFIX);
    const lines = output.split('\n');
    const placeholderLine = lines.find(l => l.trim().startsWith(PANEL_PLACEHOLDER_PREFIX))!;
    const data = decodePanelPlaceholder(placeholderLine);
    expect(data).not.toBeNull();
    expect(data!.type).toBe('info');
    expect(data!.body).toBe('Hello');
  });

  test('preserves inner markdown verbatim including nested backtick code fences', () => {
    const input = '~~~panel type=success\nIn realtime show:```\nif (x) {}\n```\n~~~';
    const output = preprocessPanelFences(input);
    const placeholderLine = output.split('\n').find(l => l.trim().startsWith(PANEL_PLACEHOLDER_PREFIX))!;
    const data = decodePanelPlaceholder(placeholderLine)!;
    expect(data.body).toBe('In realtime show:```\nif (x) {}\n```');
  });

  test('handles multiple panels in one document', () => {
    const input = [
      '~~~panel type=info',
      'First',
      '~~~',
      '',
      'Middle',
      '',
      '~~~panel type=note',
      'Second',
      '~~~',
    ].join('\n');
    const output = preprocessPanelFences(input);
    const placeholders = output.split('\n').filter(l => l.trim().startsWith(PANEL_PLACEHOLDER_PREFIX));
    expect(placeholders.length).toBe(2);
    expect(decodePanelPlaceholder(placeholders[0])!.type).toBe('info');
    expect(decodePanelPlaceholder(placeholders[1])!.type).toBe('note');
  });

  test('ignores panel opener with unknown type', () => {
    const input = '~~~panel type=foobar\nHello\n~~~';
    const output = preprocessPanelFences(input);
    expect(output).not.toContain(PANEL_PLACEHOLDER_PREFIX);
    expect(output).toBe(input);
  });

  test('is case-insensitive on type name', () => {
    const input = '~~~panel type=INFO\nHello\n~~~';
    const output = preprocessPanelFences(input);
    const placeholderLine = output.split('\n').find(l => l.trim().startsWith(PANEL_PLACEHOLDER_PREFIX))!;
    expect(decodePanelPlaceholder(placeholderLine)!.type).toBe('info');
  });

  test('accepts all 8 callout type names', () => {
    const types = ['note', 'tip', 'important', 'warning', 'caution', 'info', 'error', 'success'];
    for (const t of types) {
      const out = preprocessPanelFences(`~~~panel type=${t}\nbody\n~~~`);
      expect(out).toContain(PANEL_PLACEHOLDER_PREFIX);
    }
  });

  test('leaves unclosed panel fence as-is', () => {
    const input = '~~~panel type=info\nNever closes';
    const output = preprocessPanelFences(input);
    expect(output).not.toContain(PANEL_PLACEHOLDER_PREFIX);
  });

  test('does not detect ~~~panel inside a backtick code fence', () => {
    const input = [
      '```',
      '~~~panel type=info',
      'inside code',
      '~~~',
      '```',
    ].join('\n');
    const output = preprocessPanelFences(input);
    expect(output).not.toContain(PANEL_PLACEHOLDER_PREFIX);
  });

  test('preserves blank lines inside the panel body', () => {
    const input = [
      '~~~panel type=info',
      'First paragraph.',
      '',
      'Second paragraph.',
      '~~~',
    ].join('\n');
    const output = preprocessPanelFences(input);
    const placeholderLine = output.split('\n').find(l => l.trim().startsWith(PANEL_PLACEHOLDER_PREFIX))!;
    expect(decodePanelPlaceholder(placeholderLine)!.body).toBe('First paragraph.\n\nSecond paragraph.');
  });

  test('surrounds placeholder with blank lines', () => {
    const input = 'Before\n~~~panel type=info\nbody\n~~~\nAfter';
    const output = preprocessPanelFences(input);
    const lines = output.split('\n');
    const phIdx = lines.findIndex(l => l.trim().startsWith(PANEL_PLACEHOLDER_PREFIX));
    expect(lines[phIdx - 1].trim()).toBe('');
    expect(lines[phIdx + 1].trim()).toBe('');
  });

  test('closing fence must have no info string', () => {
    const input = [
      '~~~panel type=info',
      'hello',
      '~~~ extra',
      '~~~',
    ].join('\n');
    const output = preprocessPanelFences(input);
    const placeholderLine = output.split('\n').find(l => l.trim().startsWith(PANEL_PLACEHOLDER_PREFIX))!;
    expect(decodePanelPlaceholder(placeholderLine)!.body).toBe('hello\n~~~ extra');
  });

  test('nested ~~~lang code fence (with surrounding blank lines) does not close the panel', () => {
    const input = [
      '~~~panel type=success',
      'Before code',
      '',
      '~~~python',
      'print("hi")',
      '~~~',
      '',
      'After code',
      '~~~',
    ].join('\n');
    const output = preprocessPanelFences(input);
    const placeholders = output.split('\n').filter(l => l.trim().startsWith(PANEL_PLACEHOLDER_PREFIX));
    expect(placeholders.length).toBe(1);
    const data = decodePanelPlaceholder(placeholders[0])!;
    expect(data.body).toBe('Before code\n\n~~~python\nprint("hi")\n~~~\n\nAfter code');
  });

  test('nested ```backtick fence (with surrounding blank lines) is preserved', () => {
    const input = [
      '~~~panel type=info',
      'Before',
      '',
      '```js',
      'const x = 1;',
      '```',
      '',
      'After',
      '~~~',
    ].join('\n');
    const output = preprocessPanelFences(input);
    const placeholders = output.split('\n').filter(l => l.trim().startsWith(PANEL_PLACEHOLDER_PREFIX));
    expect(placeholders.length).toBe(1);
    const data = decodePanelPlaceholder(placeholders[0])!;
    expect(data.body).toBe('Before\n\n```js\nconst x = 1;\n```\n\nAfter');
  });

  test('nested tilde fence at start of panel body is preserved', () => {
    const input = [
      '~~~panel type=success',
      '~~~python',
      'a',
      '~~~',
      '',
      '~~~',
    ].join('\n');
    const output = preprocessPanelFences(input);
    const placeholders = output.split('\n').filter(l => l.trim().startsWith(PANEL_PLACEHOLDER_PREFIX));
    expect(placeholders.length).toBe(1);
    const data = decodePanelPlaceholder(placeholders[0])!;
    expect(data.body).toBe('~~~python\na\n~~~\n');
  });

  test('mid-paragraph ``` is treated as text, not a nested fence', () => {
    const input = [
      '~~~panel type=success',
      'In realtime show:```',
      'if (x) {}',
      '```',
      '~~~',
    ].join('\n');
    const output = preprocessPanelFences(input);
    const placeholders = output.split('\n').filter(l => l.trim().startsWith(PANEL_PLACEHOLDER_PREFIX));
    expect(placeholders.length).toBe(1);
    const data = decodePanelPlaceholder(placeholders[0])!;
    expect(data.body).toBe('In realtime show:```\nif (x) {}\n```');
  });
});
