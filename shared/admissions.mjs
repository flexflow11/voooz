/** Source-grounded admissions arithmetic. This module deliberately has no model or network access. */
const SUBJECTS = new Set(['Русский язык', 'Математика', 'Информатика', 'Физика', 'Химия', 'Биология', 'История', 'Обществознание', 'Литература', 'География', 'Иностранный язык']);
const VALUES = {
  certificate: ['Серебряная медаль', 'Золотая медаль'],
  gto: ['Бронзовый', 'Серебряный', 'Золотой'],
  sport: ['Кандидат в мастера спорта', 'Мастер спорта', 'Международные достижения'],
  essay: ['Есть зачёт'],
};
const CHANCE_REASON = 'Для вероятности поступления нужна проверенная модель на данных о конкурсах и зачислении. Нейросеть не назначает произвольный процент.';
const text = (value, max = 240) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const present = value => value != null && value !== false && value !== 0 && value !== '' && value !== 'Нет';

function officialUrl(value, sources, website) {
  try {
    const url = new URL(value), official = new URL(website);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const base = official.hostname.toLowerCase().replace(/^www\./, '');
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !host.includes('.') || host.includes(':') || /^\d+(\.\d+){3}$/.test(host) || host.endsWith('.local')) return null;
    if (!(host === base || host.endsWith(`.${base}`))) return null;
    return sources?.has(url.href) ? url.href : null;
  } catch { return null; }
}

function validateSeats(raw, program, sources, website, year = program.year) {
  if (!raw || !integer(raw.value, 0, 100_000) || raw.year !== year || raw.competitionGroup !== program.competitionGroup || raw.campus !== program.campus) return null;
  const source = officialUrl(raw.source, sources, website);
  return source ? { value: raw.value, year, source, competitionGroup: program.competitionGroup, campus: program.campus } : null;
}

function examOptions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 12).filter(option => Array.isArray(option) && option.length === 3
    && new Set(option.map(exam => exam?.subject)).size === 3
    && option.every(exam => exam && SUBJECTS.has(exam.subject) && integer(exam.minimum, 0, 100)))
    .map(option => option.map(({ subject, minimum }) => ({ subject, minimum })));
}

function achievementResult(raw, program, sources, website, profile) {
  const declared = profile.achievements || {};
  const achievements = { ...declared, sport: declared.sport ?? declared.sports };
  const active = Object.entries(VALUES).filter(([key]) => present(achievements[key]));
  const olympiad = present(achievements.olympiad ?? achievements.olympiads);
  const olympiadNotice = olympiad ? 'Олимпиадные права проверяются отдельно по названию, году, уровню олимпиады и правилам программы. Они не заменяются надбавкой к баллам.' : null;
  const unknown = reason => ({ achievementPoints: null, achievementBasis: 'needs_clarification', achievementDetails: [], achievementPending: [reason], olympiadNotice });
  if (!active.length) return { achievementPoints: 0, achievementBasis: 'self_reported', achievementDetails: [], achievementPending: [], olympiadNotice };
  if (!raw || raw.year !== program.year || raw.complete !== true || !integer(raw.maxPoints, 0, 10) || !Array.isArray(raw.items)) return unknown('Нужен полный перечень правил индивидуальных достижений этой программы на выбранный год.');
  const source = officialUrl(raw.source, sources, website);
  if (!source) return unknown('Правила достижений не подтверждены официальным источником.');
  const details = [], pending = [], groups = new Map();
  let ungrouped = 0;
  for (const [key] of active) {
    const value = achievements[key];
    if (!VALUES[key].includes(value)) { pending.push('Уточните вид достижения: общей отметки о его наличии недостаточно.'); continue; }
    const matching = raw.items.filter(item => item?.key === key && item.value === value);
    // A complete published list can establish that this achievement earns no points.
    if (!matching.length) { details.push({ key, value, points: 0, description: 'В подтверждённом полном перечне нет баллов за это достижение.', source, requiresDocuments: false }); continue; }
    // Duplicate alternatives cannot be combined without an explicit application rule.
    if (matching.length !== 1) { pending.push('У достижения несколько условий начисления: требуется уточнение.'); continue; }
    const item = matching[0];
    if (!integer(item.points, 0, 10) || item.conditionsComplete !== true || typeof item.requiresDocuments !== 'boolean' || !text(item.description, 500)) { pending.push(`Не хватает данных для начисления баллов: ${value}.`); continue; }
    const group = text(item.exclusiveGroup, 100);
    if (group) groups.set(group, Math.max(groups.get(group) || 0, item.points));
    else ungrouped += item.points;
    details.push({ key, value, points: item.points, description: text(item.description, 500), source, requiresDocuments: item.requiresDocuments, exclusiveGroup: group || null });
  }
  const points = pending.length ? null : Math.min(10, raw.maxPoints, ungrouped + [...groups.values()].reduce((sum, points) => sum + points, 0));
  return { achievementPoints: points, achievementBasis: points === null ? 'needs_clarification' : 'self_reported', achievementDetails: details, achievementPending: pending, olympiadNotice };
}

function validatedHistory(raw, program, sources, website, subjects, currentYear) {
  if (!Array.isArray(raw)) return [];
  const years = new Map();
  const accepted = raw.slice(0, 30).flatMap(item => {
    if (!item || !integer(item.year, 2022, Math.min(currentYear, program.year)) || !integer(item.value, 0, 310) || item.type !== 'last_admitted' || item.maxScore !== 310 || item.includesAchievements !== true) return [];
    if (item.competitionGroup !== program.competitionGroup || item.campus !== program.campus || item.funding !== program.funding) return [];
    if (!Array.isArray(item.subjects) || item.subjects.length !== 3 || new Set(item.subjects).size !== 3 || !subjects.every(subject => item.subjects.includes(subject))) return [];
    const source = officialUrl(item.source, sources, website);
    if (!source) return [];
    years.set(item.year, (years.get(item.year) || 0) + 1);
    return [{ value: item.value, year: item.year, source, type: 'last_admitted', subjects: [...item.subjects], funding: item.funding, competitionGroup: item.competitionGroup, campus: item.campus, maxScore: 310, includesAchievements: true, budgetSeats: validateSeats(item.budgetSeats, program, sources, website, item.year) }];
  });
  // Conflicting entries for the same year are not resolved by selecting a convenient score.
  return accepted.filter(item => years.get(item.year) === 1).sort((a, b) => b.year - a.year);
}

/** Descriptive percentage of comparable past years, never a forecast probability. */
export function historicalThresholdFit({ history, budgetSeats, competitionScore, eligible, funding }) {
  if (!eligible || funding !== 'budget' || !integer(competitionScore, 0, 310) || !budgetSeats || budgetSeats.value <= 0) return null;
  const comparable = (history || []).filter(item => item.budgetSeats?.value === budgetSeats.value);
  if (comparable.length < 3 || new Set(comparable.map(item => item.year)).size !== comparable.length) return null;
  const matching = comparable.filter(item => competitionScore >= item.value);
  return {
    percent: Math.round(100 * matching.length / comparable.length),
    matchingYears: matching.length, totalYears: comparable.length,
    years: comparable.map(item => item.year),
    method: 'historical_threshold_share', isProbability: false,
    description: `Баллов хватило бы в ${matching.length} из ${comparable.length} сопоставимых прошлых лет. Это доля прошлых лет, а не вероятность будущего зачисления; конкурс и правила могут измениться.`,
  };
}

/**
 * Validate source citations and compute one identified program. Input is untrusted AI JSON.
 * The supplied profile is expected to have passed shared/catalog.mjs validateProfile.
 */
export function validateAdmissionProgram(raw, sources, university, profile, { currentYear = new Date().getUTCFullYear() } = {}) {
  if (!raw || typeof raw !== 'object' || !profile || !Array.isArray(profile.exams) || !university?.website) return null;
  const program = text(raw.program), competitionGroup = text(raw.competitionGroup), campus = text(raw.campus);
  if (program.length < 3 || !competitionGroup || !campus || !integer(raw.year, currentYear - 1, currentYear + 1) || !['budget', 'paid'].includes(raw.funding) || typeof raw.additionalTests !== 'boolean') return null;
  const source = officialUrl(raw.source, sources, university.website);
  const options = examOptions(raw.examOptions);
  if (!source || !options.length) return null;
  const base = { program, code: text(raw.code, 40) || null, competitionGroup, campus, year: raw.year, funding: raw.funding, source };
  const examMap = new Map(profile.exams.map(exam => [exam.subject, exam.score]));
  const combinations = options.map(option => {
    const available = option.every(exam => integer(examMap.get(exam.subject), 0, 100));
    const minimaMet = available && option.every(exam => examMap.get(exam.subject) >= exam.minimum);
    return { option, available, minimaMet, score: available ? option.reduce((sum, exam) => sum + examMap.get(exam.subject), 0) : null, missing: option.filter(exam => !examMap.has(exam.subject)).length };
  }).sort((a, b) => Number(b.minimaMet) - Number(a.minimaMet) || Number(b.available) - Number(a.available) || (b.score ?? -1) - (a.score ?? -1) || a.missing - b.missing);
  const selected = combinations[0];
  const subjects = selected.option.map(exam => exam.subject);
  const unmetRequirements = selected.option.flatMap(exam => !integer(examMap.get(exam.subject), 0, 100) ? [`Не указан результат ЕГЭ: ${exam.subject}.`] : examMap.get(exam.subject) < exam.minimum ? [`${exam.subject}: ${examMap.get(exam.subject)} из минимальных ${exam.minimum}.`] : []);
  if (raw.additionalTests) unmetRequirements.push('Есть дополнительные вступительные испытания. Сценарий «три ЕГЭ + до 10 баллов» не описывает полный конкурсный балл этой программы.');
  const achievements = achievementResult(raw.achievementRules, base, sources, university.website, profile);
  let eligible = !raw.additionalTests && selected.available ? selected.minimaMet : raw.additionalTests ? null : false;
  const competitionScore = selected.available && !raw.additionalTests && achievements.achievementPoints !== null ? Math.min(310, selected.score + achievements.achievementPoints) : null;
  const budgetSeats = raw.funding === 'budget' ? validateSeats(raw.budgetSeats, base, sources, university.website) : null;
  if (budgetSeats?.value === 0) {
    eligible = false;
    unmetRequirements.push('В этой конкурсной группе нет бюджетных мест на выбранный год.');
  }
  const history = validatedHistory(raw.history, base, sources, university.website, subjects, currentYear);
  const latest = history[0];
  let applyUrl = officialUrl(raw.application?.url, sources, university.website);
  const applySource = officialUrl(raw.application?.source, sources, university.website);
  if (applyUrl) {
    const target = new URL(applyUrl), home = new URL(university.website);
    if (!applySource || (target.hostname.replace(/^www\./, '') === home.hostname.replace(/^www\./, '') && target.pathname.replace(/\/+$/, '') === home.pathname.replace(/\/+$/, ''))) applyUrl = null;
  }
  const checked = {
    ...base, subjects, examRequirements: selected.option.map(exam => ({ ...exam, score: examMap.get(exam.subject) ?? null })),
    subjectMatch: selected.available, examScore: selected.score, ...achievements,
    competitionScore, maxScore: 310, eligible, unmetRequirements,
    additionalTests: raw.additionalTests, budgetSeats, history,
    scoreMargin: competitionScore !== null && latest ? competitionScore - latest.value : null,
    applyUrl, applySource: applyUrl ? applySource : null,
    chance: null, chanceReason: CHANCE_REASON,
  };
  return { ...checked, historicalFit: historicalThresholdFit(checked) };
}
