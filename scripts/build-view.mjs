import { build } from 'esbuild';
await build({ entryPoints: ['src/react/main.tsx'], bundle: true, platform: 'browser', format: 'esm', target: 'es2022', jsx: 'automatic', outfile: '.build/tag-view.js', minify: true, define: { 'process.env.NODE_ENV': '"production"' } });
