import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifests = process.argv.slice(2);
if (!manifests.length) throw new Error('Укажите JSON-манифесты фотографий.');
const catalogPath = resolve(root, 'data/catalog.json');
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
const imagesRoot = resolve(root, 'public/images');
let added = 0;

for (const manifest of manifests) {
  const rows = JSON.parse(await readFile(resolve(root, manifest), 'utf8'));
  if (!Array.isArray(rows)) throw new Error('Манифест должен содержать массив фотографий.');
  for (const row of rows) {
    const university = catalog.universities.find(u => u.id === row.universityId);
    if (!university) throw new Error(`Неизвестный вуз: ${row.universityId}`);
    const photos = row.images || [{ ...row, universityId: undefined }];
    for (const photo of photos) {
      if (!photo.url?.startsWith('/images/') || !photo.alt || !photo.source) throw new Error('Фотографии нужны локальный путь, подпись и источник.');
      const path = resolve(root, 'public', `.${photo.url}`);
      if (!path.startsWith(imagesRoot + sep) || !(await stat(path)).isFile()) throw new Error('Изображение должно находиться в public/images.');
      const source = new URL(photo.source);
      if (source.protocol !== 'https:') throw new Error('Нужен HTTPS-источник фотографии.');
      const { universityId, ...image } = photo;
      university.images ||= [];
      const previous = university.images.findIndex(item => item.url === image.url || item.source === image.source);
      if (previous >= 0) university.images[previous] = image;
      else { university.images.push(image); added++; }
    }
  }
}

await writeFile(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
const withPhotos = catalog.universities.filter(u => u.images?.length);
console.log(`Добавлено фотографий: ${added}; вузов с фотографиями: ${withPhotos.length}`);
