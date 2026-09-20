import { cpSync, copyFileSync, existsSync } from 'node:fs';

if (existsSync('dist/browser')) {
  cpSync('dist/browser', 'dist', { recursive: true });
}

// Angular 19 SSR outputs index.csr.html instead of index.html.
// Copy index.csr.html to index.html so static artifact uploaders and web servers locate index.html.
if (existsSync('dist/index.csr.html') && !existsSync('dist/index.html')) {
  copyFileSync('dist/index.csr.html', 'dist/index.html');
}

if (existsSync('dist/browser/index.csr.html') && !existsSync('dist/browser/index.html')) {
  copyFileSync('dist/browser/index.csr.html', 'dist/browser/index.html');
}
