// IFC -> Fragments, the same IfcImporter call the Panel Station converter uses (converter/src/convert.ts), pointed at the local web-ifc wasm.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { IfcImporter } from '@thatopen/fragments';

const require = createRequire(import.meta.url);
const [inPath, outPath] = process.argv.slice(2);
const importer = new IfcImporter();
importer.wasm = { path: path.dirname(require.resolve('web-ifc')) + path.sep, absolute: true };
const bytes = new Uint8Array(await readFile(inPath));
const t0 = performance.now();
const frag = await importer.process({ bytes, progressCallback: (p, d) => { if (Math.round(p * 100) % 25 === 0) console.log('  ', Math.round(p * 100) + '%', d?.process ?? ''); } });
await writeFile(outPath, frag);
console.log(JSON.stringify({ ifcBytes: bytes.length, fragBytes: frag.length, seconds: +((performance.now() - t0) / 1000).toFixed(1) }));
