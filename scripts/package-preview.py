#!/usr/bin/env python3
"""Package the tested single-file preview for an ordinary browser download."""
import argparse
import hashlib
from pathlib import Path
import re
import shutil
from zipfile import ZipFile, ZIP_DEFLATED

parser = argparse.ArgumentParser()
parser.add_argument('--version', help='Optional release suffix, for example v2')
args = parser.parse_args()
if args.version and not re.fullmatch(r'v[0-9]+', args.version):
    parser.error('version must look like v2')

root = Path(__file__).resolve().parent.parent
html = (root / 'standalone/voooz.html').read_bytes()
if b'src="/src/main.jsx"' in html or b'<html lang="ru">' not in html:
    raise RuntimeError('Run npm run build:standalone before packaging.')

instructions = '''ВОООЗ — готовая версия для просмотра

1. Полностью распакуйте архив.
2. Откройте папку voooz.
3. Перетащите index.html в окно Chrome, Edge, Firefox или Safari на компьютере.

Приложение уже собрано. Каталог, фотографии, города, избранное,
анкета ЕГЭ и предварительный подбор работают без установки и сервера.
Переходы на официальные сайты вузов требуют подключения к интернету.

В исходном коде подготовлено серверное подключение Yandex AI Studio.
Этот автономный HTML не содержит ключа и не вызывает нейросеть.
Для живого AI-анализа нужны ключ, каталог Yandex и размещённый сервер.
Проходные баллы и проценты поступления не выдумываются;
каталог ещё не является полным действующим реестром.
Исходный код: https://github.com/flexflow11/voooz/tree/voooz-delivery
'''

out = root / 'downloads'
out.mkdir(exist_ok=True)
names = ['voooz-open.zip']
if args.version:
    names.append(f'voooz-open-{args.version}.zip')

for name in names:
    target = out / name
    temporary = target.with_suffix('.zip.tmp')
    with ZipFile(temporary, 'w', ZIP_DEFLATED, compresslevel=9) as archive:
        archive.writestr('voooz/index.html', html)
        archive.writestr('voooz/КАК ОТКРЫТЬ.txt', instructions)
    with ZipFile(temporary) as archive:
        if archive.testzip() is not None or archive.read('voooz/index.html') != html:
            raise RuntimeError('Preview ZIP did not pass integrity checks.')
    temporary.replace(target)
    print(f'{target}: {target.stat().st_size} bytes')

(root / 'docs').mkdir(exist_ok=True)
shutil.copyfile(root / 'standalone/voooz.html', root / 'docs/index.html')
print(f'Embedded HTML SHA256: {hashlib.sha256(html).hexdigest()}')
