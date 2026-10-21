import { build } from 'vite';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = resolve(root, 'public');
const catalogPath = resolve(root, 'data/catalog.json');
const outputDirectory = resolve(root, 'standalone');
const outputPath = resolve(outputDirectory, 'voooz.html');
const types = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

// Keep both campus photographs inside the HTML rather than relative URLs.
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
for (const university of catalog.universities) {
  for (const photo of university.images || []) {
    if (!photo.url?.startsWith('/')) throw new Error('Автономная сборка требует локальные изображения.');
    const path = resolve(publicRoot, `.${photo.url}`);
    if (!path.startsWith(publicRoot + sep)) throw new Error('Недопустимый путь изображения.');
    const mime = types[extname(path)];
    if (!mime) throw new Error('Неизвестный формат изображения.');
    photo.url = `data:${mime};base64,${(await readFile(path)).toString('base64')}`;
  }
}

const result = await build({
  root,
  configFile: false,
  mode: 'standalone',
  // Vite library builds normally leave this for the consuming application;
  // the exported file has no Node globals or downstream bundler.
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  plugins: [{
    name: 'inline-standalone-catalog',
    enforce: 'pre',
    transform(code, id) {
      if (id.split('?')[0] === catalogPath) return JSON.stringify(catalog);
    },
  }],
  build: {
    write: false,
    minify: true,
    sourcemap: false,
    cssCodeSplit: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    lib: { entry: resolve(root, 'src/main.jsx'), name: 'Voooz', formats: ['iife'] },
  },
});

const chunks = (Array.isArray(result) ? result : [result]).flatMap(bundle => bundle.output);
const scripts = chunks.filter(item => item.type === 'chunk');
if (scripts.length !== 1 || scripts[0].imports.length || scripts[0].dynamicImports.length) {
  throw new Error('Автономная сборка должна содержать ровно один скрипт без импортов.');
}
const styles = chunks.filter(item => item.type === 'asset' && item.fileName.endsWith('.css')).map(item => item.source).join('\n');
if (!styles) throw new Error('Стили не попали в автономную сборку.');
const script = scripts[0].code.replace(/<\/script/gi, '<\\/script');
const favicon = `data:image/svg+xml;base64,${(await readFile(resolve(publicRoot, 'favicon.svg'))).toString('base64')}`;
const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#f7f8f2">
<meta name="description" content="Автономная версия ВОООЗ для просмотра: каталог, города, избранное и анкета ЕГЭ.">
<title>ВОООЗ — открыть приложение</title>
<link rel="icon" href="${favicon}">
<style>${styles.replace(/<\/style/gi, '<\\/style')}</style>
</head>
<body>
<noscript>Для приложения нужен JavaScript. Открой этот HTML-файл в обычном браузере с включённым JavaScript.</noscript>
<div id="root"></div>
<script>${script}</script>
</body>
</html>`;

if (/\b(?:src|href)=["'](?:\/src\/|\/assets\/|https?:\/\/)/i.test(html)) {
  throw new Error('HTML всё ещё требует внешние скрипты или ресурсы.');
}
await mkdir(outputDirectory, { recursive: true });
await writeFile(outputPath, html);
console.log(`Автономное приложение: ${outputPath} (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MiB)`);
