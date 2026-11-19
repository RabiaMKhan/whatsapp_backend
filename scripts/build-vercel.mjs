// Builds the API for Vercel with the Build Output API (v3):
// https://vercel.com/docs/build-output-api/v3
//
//   .vercel/output/
//     config.json                   every path → the "api" function
//     functions/api.func/
//       index.mjs                   src/vercel.ts + all dependencies, one file
//       .vc-config.json             Node.js runtime settings
//
// Bundling everything into one file means Vercel doesn't have to resolve the
// workspace package (@chat/shared ships TypeScript) or our extensionless ESM
// imports. Run locally with `npm run build:vercel` to check the output.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { build } from 'tsup';

const OUT = '.vercel/output';
const FN = `${OUT}/functions/api.func`;

// Optional MongoDB driver add-ons we don't use. The driver loads them inside
// try/catch, so leaving them out of the bundle is safe.
const OPTIONAL = [
  '@aws-sdk/credential-providers',
  '@mongodb-js/zstd',
  'kerberos',
  'snappy',
  'mongodb-client-encryption',
  'gcp-metadata',
  'socks',
  'aws4',
  'pino-pretty', // development logs only
];

await rm(OUT, { recursive: true, force: true });

await build({
  config: false, // ignore tsup.config.ts (that one is the normal `npm run build`)
  entry: { index: 'src/vercel.ts' },
  outDir: FN,
  format: ['esm'],
  outExtension: () => ({ js: '.mjs' }),
  platform: 'node',
  target: 'node22',
  noExternal: [/.*/],
  external: OPTIONAL,
  splitting: false,
  sourcemap: false,
  clean: false,
  shims: true, // __dirname / __filename for dependencies that still use them
  // Bundled CommonJS packages call require(); give the ES module one.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});

await writeFile(
  `${FN}/.vc-config.json`,
  JSON.stringify(
    {
      runtime: 'nodejs22.x',
      handler: 'index.mjs',
      launcherType: 'Nodejs',
      shouldAddHelpers: false,
      maxDuration: 30,
    },
    null,
    2,
  ),
);

await mkdir(OUT, { recursive: true });
await writeFile(
  `${OUT}/config.json`,
  JSON.stringify({ version: 3, routes: [{ src: '/(.*)', dest: '/api' }] }, null, 2),
);

console.log(`Vercel build ready in ${OUT}`);
