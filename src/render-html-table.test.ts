import { describe, it, expect } from 'bun:test';
import { renderHtmlTable } from './embed-preprocess';
import type { HtmlTableMeta } from './html-table-parser';

describe('renderHtmlTable', () => {
  it('renders a simple table with header and body', () => {
    const meta: HtmlTableMeta = {
      rows: [
        { header: true, cells: [{ runs: [{ type: 'text', text: 'Name' }] }, { runs: [{ type: 'text', text: 'Age' }] }] },
        { header: false, cells: [{ runs: [{ type: 'text', text: 'Alice' }] }, { runs: [{ type: 'text', text: '30' }] }] },
      ],
    };
    const html = renderHtmlTable(meta);

    expect(html).toContain('<table>');
    expect(html).toContain('</table>');
    expect(html).toContain('<thead>');
    expect(html).toContain('<th>Name</th>');
    expect(html).toContain('<th>Age</th>');
    expect(html).toContain('</thead>');
    expect(html).toContain('<tbody>');
    expect(html).toContain('<td>Alice</td>');
    expect(html).toContain('<td>30</td>');
    expect(html).toContain('</tbody>');
  });

  it('renders a table with no header rows', () => {
    const meta: HtmlTableMeta = {
      rows: [
        { header: false, cells: [{ runs: [{ type: 'text', text: 'a' }] }] },
        { header: false, cells: [{ runs: [{ type: 'text', text: 'b' }] }] },
      ],
    };
    const html = renderHtmlTable(meta);

    expect(html).not.toContain('<thead>');
    expect(html).not.toContain('<th>');
    expect(html).toContain('<tbody>');
    expect(html).toContain('<td>a</td>');
  });

  it('renders colspan and rowspan attributes', () => {
    const meta: HtmlTableMeta = {
      rows: [
        {
          header: true,
          cells: [
            { runs: [{ type: 'text', text: 'Merged' }], colspan: 2 },
            { runs: [{ type: 'text', text: 'C' }] },
          ],
        },
        {
          header: false,
          cells: [
            { runs: [{ type: 'text', text: 'Span' }], rowspan: 2 },
            { runs: [{ type: 'text', text: '1' }] },
            { runs: [{ type: 'text', text: '2' }] },
          ],
        },
      ],
    };
    const html = renderHtmlTable(meta);

    expect(html).toContain('colspan="2"');
    expect(html).toContain('rowspan="2"');
  });

  it('renders hardbreak runs as <br>', () => {
    const meta: HtmlTableMeta = {
      rows: [
        { header: false, cells: [{ runs: [
          { type: 'text', text: 'line1' },
          { type: 'hardbreak', text: '' },
          { type: 'text', text: 'line2' },
        ] }] },
      ],
    };
    const html = renderHtmlTable(meta);

    expect(html).toContain('line1<br>line2');
  });

  it('renders multiple header rows in thead', () => {
    const meta: HtmlTableMeta = {
      rows: [
        { header: true, cells: [{ runs: [{ type: 'text', text: 'H1' }] }] },
        { header: true, cells: [{ runs: [{ type: 'text', text: 'H2' }] }] },
        { header: false, cells: [{ runs: [{ type: 'text', text: 'D' }] }] },
      ],
    };
    const html = renderHtmlTable(meta);

    // Both header rows should be in thead
    const theadMatch = html.match(/<thead>([\s\S]*?)<\/thead>/);
    expect(theadMatch).not.toBeNull();
    expect(theadMatch![1]).toContain('H1');
    expect(theadMatch![1]).toContain('H2');
  });

  it('renders empty cells', () => {
    const meta: HtmlTableMeta = {
      rows: [
        { header: false, cells: [{ runs: [{ type: 'text', text: '' }] }] },
      ],
    };
    const html = renderHtmlTable(meta);

    expect(html).toContain('<td></td>');
  });
});
