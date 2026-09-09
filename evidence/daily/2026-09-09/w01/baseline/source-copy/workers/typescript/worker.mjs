import { parse } from './src/parse.mjs';

// One bounded request per process; all code is data, compiler host is memory-only.
const chunks=[]; let bytes=0;
try {
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if(bytes > 160 * 1024 * 1024) throw new Error('input_limit');
    chunks.push(chunk);
  }
  const result=parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  process.stdout.write(JSON.stringify(result));
} catch {
  process.stderr.write('atlas_worker_failed\n');
  process.exitCode=1;
}
