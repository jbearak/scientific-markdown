/**
 * Builds a test .xlsx fixture with merged cells (colspan).
 * Run: bun run test/fixtures/tables/build-embed-xlsx.ts
 */
import * as XLSX from '@e965/xlsx';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';

const ws = XLSX.utils.aoa_to_sheet([
  ['Fruit', 'Nutritional Information', null, 'Season'],
  [null, 'Calories', 'Fiber (g)', null],
  ['Apple', 95, 4.4, 'Autumn'],
  ['Mango', 201, 5.4, 'Summer'],
  ['Strawberry', 49, 3.0, 'Spring'],
]);

// Merge "Nutritional Information" across B1:C1 for colspan demo
ws['!merges'] = [{ s: { r: 0, c: 1 }, e: { r: 0, c: 2 } }];

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Fruits');

const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
const outPath = join(dirname(new URL(import.meta.url).pathname), 'embed.xlsx');
writeFileSync(outPath, buf);
console.log('Wrote', outPath);
