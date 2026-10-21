/** Pure catalog logic shared by the server and the standalone Mini App preview. */
const subjects = ['Русский язык', 'Математика', 'Информатика', 'Физика', 'Химия', 'Биология', 'История', 'Обществознание', 'Литература', 'География', 'Иностранный язык'];
const aliases = { russian: 'Русский язык', math: 'Математика', mathematics: 'Математика', informatics: 'Информатика', physics: 'Физика', chemistry: 'Химия', biology: 'Биология', history: 'История', social: 'Обществознание', social_studies: 'Обществознание', literature: 'Литература', geography: 'География', foreign: 'Иностранный язык', english: 'Иностранный язык', 'Профильная математика': 'Математика', 'Математика (профильная)': 'Математика', 'Английский язык': 'Иностранный язык', 'Немецкий язык': 'Иностранный язык', 'Французский язык': 'Иностранный язык', 'Испанский язык': 'Иностранный язык', 'Китайский язык': 'Иностранный язык' };
export const noKeyNotice = 'Подбор работает по справочному каталогу. Проходные баллы и требования к поступлению уточняйте на сайте приёмной комиссии.';

export const admissionsDisclaimer = 'Прошлогодний проходной балл не гарантирует поступление. Дополнительные баллы за достижения, олимпиады, вступительные испытания и набор предметов проверяются по правилам конкретной программы.';

function str(v, max = 200) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }
function error(message, status = 400) { return Object.assign(new Error(message), { status }); }

export function validateProfile(body, catalog) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw error('Укажите данные ЕГЭ.');
  const exams = body.exams ?? body.ege;
  if (!Array.isArray(exams) || exams.length < 2 || exams.length > 6) throw error('Добавьте от 2 до 6 предметов ЕГЭ.');
  const seen = new Set();
  const validated = exams.map(e => {
    if (!e || typeof e !== 'object') throw error('Некорректный предмет ЕГЭ.');
    const subject = aliases[e.subject] || e.subject;
    if (!subjects.includes(subject)) throw error('Выберите предмет из списка.');
    if (seen.has(subject)) throw error('Предметы ЕГЭ не должны повторяться.');
    seen.add(subject);
    if (typeof e.score !== 'number' || !Number.isInteger(e.score) || e.score < 0 || e.score > 100) throw error('Балл за каждый предмет — целое число от 0 до 100.');
    return { subject, score: e.score };
  });
  const city = str(body.city || body.cityId, 100);
  if (city && !catalog.cities.some(c => c.id === city)) throw error('Город не найден в каталоге.');
  const specialty = str(body.specialty, 240);
  if (body.specialty != null && typeof body.specialty !== 'string') throw error('Некорректная специальность.');
  if (body.notes != null && typeof body.notes !== 'string') throw error('Некорректное примечание к достижениям.');
  const notes = str(body.notes, 1000);
  const achievements = {};
  if (body.achievements != null && (typeof body.achievements !== 'object' || Array.isArray(body.achievements))) throw error('Некорректные достижения.');
  for (const [name, value] of Object.entries(body.achievements || {})) {
    if (!['olympiad', 'olympiads', 'certificate', 'sport', 'sports', 'gto', 'essay'].includes(name)) continue;
    if (!['string', 'boolean', 'number'].includes(typeof value)) throw error('Некорректное достижение.');
    achievements[name] = typeof value === 'string' ? str(value, 240) : value;
  }
  return { exams: validated, specialty, achievements, city, notes };
}

export function localReason(university, specialty) {
  if (specialty) return `Тематический поиск по направлению «${specialty}». Проверьте наличие конкретной программы и требования к ЕГЭ на сайте приёмной комиссии.`;
  return 'Вуз из справочного каталога. Для оценки поступления нужны конкретная программа, набор ЕГЭ и результаты приёма за указанный год.';
}

const subjectKeywords = {
  Информатика: ['информат', 'программ', 'it', 'компьютер', 'цифров', 'технолог'],
  Физика: ['физик', 'инженер', 'техничес', 'технолог', 'энергет', 'авиа'],
  Химия: ['хими', 'медицин', 'фармац', 'биотех'],
  Биология: ['биолог', 'медицин', 'аграр', 'ветеринар', 'биотех', 'эколог'],
  История: ['истори', 'гуманитар', 'право', 'юрид', 'международ'],
  Обществознание: ['эконом', 'менедж', 'право', 'юрид', 'соци', 'гуманитар', 'управлен'],
  Литература: ['литератур', 'журнал', 'филолог', 'искусств', 'гуманитар'],
  География: ['географ', 'геолог', 'эколог', 'туризм'],
  'Иностранный язык': ['лингвист', 'филолог', 'международ', 'язык', 'перевод'],
};

export function localRecommendations(candidates, profile, catalog) {
  const specialtyRecord = catalog.specialties.find(s => s.code === profile.specialty || s.name === profile.specialty);
  const specialtyName = specialtyRecord?.name || profile.specialty;
  const terms = specialtyName.toLocaleLowerCase('ru').split(/[\s,()\-/]+/).filter(w => w.length >= 5);
  const subjectTerms = profile.exams.flatMap(e => subjectKeywords[e.subject] || []);
  const scored = candidates.map(university => {
    const haystack = `${university.name} ${university.description} ${(university.tags || []).join(' ')}`.toLocaleLowerCase('ru');
    const specialtyHits = terms.filter(t => haystack.includes(t.slice(0, Math.max(5, t.length - 3)))).length;
    const subjectHits = subjectTerms.filter(t => haystack.includes(t)).length;
    return { university, score: specialtyHits * 10 + subjectHits, specialtyHits, subjectHits };
  }).sort((a, b) => b.score - a.score);
  return scored.slice(0, 6).map(({ university, specialtyHits, subjectHits }) => ({
    university,
    reason: specialtyHits > 0
      ? `В описании вуза есть направления, близкие к «${specialtyName}». Это тематическое совпадение; наличие программы и условия поступления нужно проверить.`
      : subjectHits > 0 && !specialtyName
        ? 'Направления вуза тематически связаны с вашими предметами ЕГЭ. Требуемый набор экзаменов зависит от конкретной программы.'
        : localReason(university, specialtyName),
    passingScore: null,
    subjectMatch: null,
    relevance: specialtyHits > 0 || (!specialtyName && subjectHits > 0) ? 'thematic' : 'catalog',
  }));
}

/** Filter the supplied snapshot without changing its order or records. */
export function filterUniversities(catalog, { city: rawCity, q: rawQuery, category: rawCategory } = {}) {
  const city = str(rawCity, 100);
  const q = str(rawQuery, 100).toLocaleLowerCase('ru');
  const category = str(rawCategory, 100).toLocaleLowerCase('ru');
  if (city && !catalog.cities.some(c => c.id === city)) throw error('Город не найден.', 404);
  return catalog.universities.filter(u =>
    (!city || u.cityId === city)
    && (!q || `${u.name} ${u.shortName} ${u.description} ${(u.aliases || []).join(' ')}`.toLocaleLowerCase('ru').includes(q))
    && (!category || category === 'all' || `${u.category || ''} ${(u.categories || []).join(' ')} ${(u.tags || []).join(' ')}`.toLocaleLowerCase('ru').includes(category))
  );
}

/** Produce the complete deterministic no-AI response, usable without a network. */
export function createCatalogRecommendations(body, catalog) {
  const profile = validateProfile(body, catalog);
  const candidates = filterUniversities(catalog, { city: profile.city });
  return {
    totalScore: profile.exams.reduce((total, e) => total + e.score, 0),
    achievementPoints: null,
    profile,
    recommendations: localRecommendations(candidates, profile, catalog),
    ai: { configured: false, used: false },
    notice: noKeyNotice,
    disclaimer: admissionsDisclaimer,
  };
}
