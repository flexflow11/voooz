import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { apiFetch } from './api.mjs';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUpRight, Award, BookOpen, Bookmark, Check, ChevronDown, ChevronRight, Compass, ExternalLink, GraduationCap, Info, Landmark, LoaderCircle, MapPin, Plus, Search, ShieldCheck, SlidersHorizontal, Sparkles, Star, Trophy, X } from 'lucide-react';

const standaloneMode = import.meta.env.MODE === 'standalone';

const categories = [
  ['all', 'Все направления'], ['tech', 'IT и технологии'], ['economics', 'Экономика'],
  ['medicine', 'Медицина'], ['humanities', 'Гуманитарные науки'], ['science', 'Естественные науки'], ['creative', 'Творчество'],
];
const subjects = ['Русский язык', 'Математика (профильная)', 'Информатика', 'Физика', 'Обществознание', 'История', 'Биология', 'Химия', 'Литература', 'География', 'Английский язык', 'Немецкий язык', 'Французский язык', 'Испанский язык', 'Китайский язык'];
const achievementFields = [
  { key: 'olympiad', label: 'Олимпиады', icon: Trophy, options: ['Нет', 'Участник', 'Призёр', 'Победитель'], hint: 'Укажи олимпиаду и год в примечании. Льготы зависят от её перечня, уровня и правил вуза.' },
  { key: 'certificate', label: 'Аттестат с отличием', icon: Award, options: ['Нет', 'Серебряная медаль', 'Золотая медаль'], hint: 'Вуз сам определяет, учитывает ли медаль и сколько баллов за неё даёт.' },
  { key: 'sport', label: 'Спортивные звания', icon: Star, options: ['Нет', 'Кандидат в мастера спорта', 'Мастер спорта', 'Международные достижения'], hint: 'Условия учёта зависят от вида спорта и правил приёма.' },
  { key: 'gto', label: 'Знак ГТО', icon: ShieldCheck, options: ['Нет', 'Бронзовый', 'Серебряный', 'Золотой'], hint: 'Учитываются действующие документы в соответствии с правилами вуза.' },
  { key: 'essay', label: 'Итоговое сочинение', icon: BookOpen, options: ['Нет', 'Есть зачёт'], hint: 'Наличие зачёта само по себе не гарантирует дополнительные баллы.' },
];

function readLocal(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    if (key === 'voooz-city') return typeof value === 'string' && value.length < 100 ? value : fallback;
    if (key === 'voooz-saved') return Array.isArray(value) ? [...new Set(value.filter(id => typeof id === 'string' && id.length < 150))] : fallback;
    if (key === 'voooz-profile') {
      if (!value || typeof value !== 'object' || !Array.isArray(value.exams) || value.exams.length < 3 || value.exams.length > 5 || !value.exams.every(e => e && subjects.includes(e.subject) && ['string', 'number'].includes(typeof e.score))) return fallback;
      return { exams: value.exams.map(e => ({ subject: e.subject, score: e.score })), specialty: typeof value.specialty === 'string' ? value.specialty : '', achievements: value.achievements && typeof value.achievements === 'object' && !Array.isArray(value.achievements) ? value.achievements : {}, notes: typeof value.notes === 'string' ? value.notes.slice(0, 1000) : '' };
    }
    return value ?? fallback;
  } catch { return fallback; }
}
function useStored(key, initial) {
  const [value, setValue] = useState(() => readLocal(key, initial));
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private browsers can disable storage */ } }, [key, value]);
  return [value, setValue];
}
function normalize(value = '') { return value.toLocaleLowerCase('ru').replaceAll('ё', 'е'); }
function safeUrl(value) { try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; } }
function sameExam(a, b) { return a === b || a.endsWith('язык') && b.endsWith('язык') && a !== 'Русский язык' && b !== 'Русский язык'; }
function examScoreError(value) {
  if (String(value ?? '').trim() === '') return 'Укажи балл за этот предмет';
  const score = Number(value);
  if (!Number.isFinite(score) || score < 0 || score > 100) return 'Баллы должны быть от 0 до 100';
  if (!Number.isInteger(score)) return 'Укажи целое число';
  return '';
}
function sourceUrl(source) { return typeof source === 'string' ? source : source?.url; }
function Photo({ photo, title, className = '', loading = 'lazy' }) {
  const [broken, setBroken] = useState(false);
  const url = typeof photo === 'string' ? photo : photo?.url;
  useEffect(() => setBroken(false), [url]);
  return url && !broken ? <img className={className} src={url} alt={photo?.alt || title} loading={loading} onError={() => setBroken(true)} /> : <div className={`photo-fallback ${className}`} role="img" aria-label={`Университет ${title}`}><Landmark strokeWidth={1} /><span>{title}</span></div>;
}
function Modal({ title, onClose, children, wide = false, className = '' }) {
  const id = useId();
  const ref = useRef();
  useEffect(() => {
    const before = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const node = ref.current;
    node?.focus();
    function keydown(e) {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      if (e.key === 'Tab') {
        const items = [...node.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]')].filter(el => el.getClientRects().length);
        if (!items.length) return;
        const first = items[0], last = items.at(-1);
        if (e.shiftKey && (document.activeElement === first || document.activeElement === node)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    node?.addEventListener('keydown', keydown);
    return () => { document.body.style.overflow = overflow; node?.removeEventListener('keydown', keydown); before?.focus?.(); };
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <section className={`modal ${wide ? 'modal-wide' : ''} ${className}`} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} ref={ref}>
      <div className="modal-heading"><h2 id={id}>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Закрыть"><X size={22} /></button></div>
      {children}
    </section>
  </div>;
}

function CityPicker({ cities, selected, onSelect, onClose }) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => cities.filter(c => normalize(`${c.name} ${c.region || ''}`).includes(normalize(query))), [cities, query]);
  const popularNames = ['Москва', 'Санкт-Петербург', 'Казань', 'Новосибирск', 'Екатеринбург', 'Томск'];
  return <Modal title="В каком городе будем учиться?" onClose={onClose} className="city-modal">
    <p className="modal-subtitle">Можно выбрать город или посмотреть вузы по всей России.</p>
    <label className="search-field"><Search size={19} /><input autoFocus placeholder="Найти город" value={query} onChange={e => setQuery(e.target.value)} aria-label="Поиск города" />{query && <button className="icon-button small" onClick={() => setQuery('')} aria-label="Очистить поиск"><X size={16} /></button>}</label>
    {!query && <><button className={`city-option country-option ${!selected ? 'selected' : ''}`} onClick={() => onSelect(null)}><span><Compass size={20} /> Вся Россия</span>{!selected && <Check size={19} />}</button><div className="field-caption">ПОПУЛЯРНЫЕ ГОРОДА</div><div className="popular-cities">{popularNames.map(name => { const city = cities.find(c => c.name === name); return city && <button key={city.id} className={city.id === selected ? 'active' : ''} onClick={() => onSelect(city.id)}>{name}</button>; })}</div></>}
    <div className="field-caption">{query ? `НАЙДЕНО: ${filtered.length}` : `ГОРОДА КАТАЛОГА · ${cities.length}`}</div>
    <div className="city-list">{filtered.map(city => <button className={`city-option ${city.id === selected ? 'selected' : ''}`} key={city.id} onClick={() => onSelect(city.id)}><span><span className="city-name">{city.name}</span><small>{city.region || 'Россия'}</small></span>{city.id === selected ? <Check size={19} /> : <ChevronRight size={17} />}</button>)}{!filtered.length && <div className="empty-inline">Такого города пока нет в каталоге. Попробуй другое название.</div>}</div>
    <p className="muted fine-print">Список основан на открытом каталоге вузов и может не охватывать все филиалы.</p>
  </Modal>;
}

function UniversityCard({ university: u, city, saved, onSave, onOpen, index }) {
  return <article className="university-card" style={{ '--card-delay': `${Math.min(index, 5) * 45}ms` }}>
    <div className="card-photo-wrap"><button className="card-photo-button" onClick={() => onOpen(u)} aria-label={`Подробнее: ${u.name}`}><Photo photo={u.images?.[0]} title={u.shortName || u.name} className="card-photo" /><div className="photo-shade" /></button><span className="card-location"><MapPin size={12} />{city?.name || u.city || 'Россия'}</span><button className={`save-button ${saved ? 'saved' : ''}`} onClick={() => onSave(u.id)} aria-label={saved ? `Убрать ${u.shortName || u.name} из избранного` : `Сохранить ${u.shortName || u.name}`} aria-pressed={saved}><Bookmark size={18} fill={saved ? 'currentColor' : 'none'} /></button></div>
    <div className="card-body"><div className="card-eyebrow">{u.type || (u.activeStatus === 'needs_verification' ? 'ФИЛИАЛ · ДАННЫЕ 2022' : 'УНИВЕРСИТЕТ')}<span className="tiny-dot" />{(u.tags || [])[0] || 'Высшее образование'}</div><button className="card-title-button" onClick={() => onOpen(u)}><h3>{u.shortName || u.name}</h3><ArrowUpRight size={21} /></button><p className="full-university-name">{u.name}</p><p className="card-description">{u.description}</p><div className="card-footer"><span><GraduationCap size={16} />{(u.tags || []).slice(1, 3).join(' · ') || 'Бакалавриат и специалитет'}</span><button onClick={() => onOpen(u)}>Подробнее <ArrowRight size={15} /></button></div></div>
  </article>;
}

function Profile({ catalog, profile, setProfile, onClose, onSubmit, pending, error, cityName }) {
  const [specialtySearch, setSpecialtySearch] = useState('');
  const [specialtyOpen, setSpecialtyOpen] = useState(!!profile.specialty);
  const [validationAttempted, setValidationAttempted] = useState(false);
  const [touchedSubjects, setTouchedSubjects] = useState({});
  const formRef = useRef();
  const specialities = catalog.specialties || [];
  const found = useMemo(() => specialities.filter(s => normalize(`${s.code} ${s.name} ${(s.keywords || []).join(' ')} ${s.level || ''}`).includes(normalize(specialtySearch))), [specialities, specialtySearch]);
  const selectedSpecialty = specialities.find(s => s.code === profile.specialty);
  const sum = profile.exams.reduce((acc, e) => acc + (Number(e.score) || 0), 0);
  function updateExam(index, key, value) { setProfile(p => ({ ...p, exams: p.exams.map((e, i) => i === index ? { ...e, [key]: value } : e) })); }
  function submitProfile(event) {
    event.preventDefault();
    setValidationAttempted(true);
    const firstInvalid = profile.exams.findIndex(exam => examScoreError(exam.score));
    if (firstInvalid !== -1) {
      requestAnimationFrame(() => {
        const input = formRef.current?.querySelector(`[name="ege-score-${firstInvalid}"]`);
        input?.focus({ preventScroll: true });
        input?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
      return;
    }
    onSubmit();
  }
  return <Modal title="Твой путь в университет" wide onClose={onClose} className="profile-modal">
    <div className="profile-intro"><span className="tag"><SlidersHorizontal size={14} /> Характеристики</span><p>Расскажи немного о себе — найдём, с чего начать.</p></div>
    <form ref={formRef} noValidate onSubmit={submitProfile}>
      <div className="profile-grid"><div className="profile-form"><div className="section-heading"><span className="step-number">01</span><div><h3>Твои результаты ЕГЭ</h3><p>Укажи от 3 до 5 предметов и баллы за каждый.</p></div></div>
        <div className="exam-labels"><span>Предмет</span><span>Баллы</span></div>
        <div className="exam-rows">{profile.exams.map((exam, index) => {
          const fieldError = (validationAttempted || touchedSubjects[exam.subject]) ? examScoreError(exam.score) : '';
          return <div className="exam-entry" key={index}>
            <div className="exam-row">
              <select value={exam.subject} aria-label={`Предмет ${index + 1}`} onChange={e => updateExam(index, 'subject', e.target.value)}>{subjects.map(s => <option key={s} disabled={profile.exams.some((e, i) => i !== index && sameExam(e.subject, s))}>{s}</option>)}</select>
              <input type="number" name={`ege-score-${index}`} min="0" max="100" step="1" required inputMode="numeric" placeholder="0–100" aria-label={`Баллы: ${exam.subject}`} aria-invalid={!!fieldError} aria-describedby={fieldError ? `ege-score-error-${index}` : undefined} value={exam.score} onChange={e => updateExam(index, 'score', e.target.value)} onBlur={() => setTouchedSubjects(t => ({ ...t, [exam.subject]: true }))} />
              {index > 2 && <button className="icon-button" type="button" aria-label={`Удалить предмет ${index + 1}`} onClick={() => setProfile(p => ({ ...p, exams: p.exams.filter((_, i) => i !== index) }))}><X size={16} /></button>}
            </div>
            {fieldError && <div className="exam-field-error" id={`ege-score-error-${index}`} role="status"><span className="field-error-icon"><BookOpen size={16} strokeWidth={1.6} /></span><div><strong>{fieldError}</strong><span>Так мы сможем подобрать твой университет</span></div></div>}
          </div>;
        })}</div>
        {profile.exams.length < 5 && <button type="button" className="text-button add-exam" onClick={() => setProfile(p => ({ ...p, exams: [...p.exams, { subject: subjects.find(s => !p.exams.some(e => sameExam(e.subject, s))), score: '' }] }))}><Plus size={16} /> Добавить предмет</button>}
        <div className="section-heading second-section"><span className="step-number">02</span><div><h3>Что тебе интересно?</h3><p>Необязательно. Направление можно выбрать позже.</p></div></div>
        <div className="specialty-accordion"><button className="accordion-trigger" type="button" aria-expanded={specialtyOpen} onClick={() => setSpecialtyOpen(o => !o)}><span><BookOpen size={18} />{selectedSpecialty?.name || 'Специальность'}</span><ChevronDown size={19} className={specialtyOpen ? 'rotated' : ''} /></button>{specialtyOpen && <div className="specialty-body"><label className="search-field"><Search size={18} /><input placeholder="Профессия, направление или код" aria-label="Поиск специальности" value={specialtySearch} onChange={e => setSpecialtySearch(e.target.value)} /></label><div className="specialty-count">{found.length} направлений · бакалавриат и специалитет</div><div className="specialty-list"><button type="button" className={!profile.specialty ? 'chosen' : ''} onClick={() => setProfile(p => ({ ...p, specialty: '' }))}>Пока не определился{!profile.specialty && <Check size={16} />}</button>{found.slice(0, 100).map(s => <button type="button" key={s.code} className={profile.specialty === s.code ? 'chosen' : ''} onClick={() => { setProfile(p => ({ ...p, specialty: s.code })); setSpecialtyOpen(false); }}><span><small>{s.code} · {s.level}</small>{s.name}</span>{profile.specialty === s.code && <Check size={16} />}</button>)}{found.length > 100 && <p className="fine-print muted">Уточни поиск, чтобы увидеть остальные направления.</p>}{!found.length && <p className="empty-inline">Ничего не найдено. Попробуй «программирование», «врач» или код направления.</p>}</div></div>}</div>
        <div className="section-heading second-section"><span className="step-number">03</span><div><h3>Твои достижения</h3><p>Если есть — добавь, чтобы не забыть проверить льготы.</p></div></div>
        <div className="achievements">{achievementFields.map(({ key, label, icon: Icon, options, hint }) => <details key={key}><summary><span><Icon size={18} />{label}</span><span className="achievement-summary">{profile.achievements[key] && profile.achievements[key] !== 'Нет' ? <span className="achievement-mark"><Check size={14} />Есть</span> : null}<ChevronDown size={18} /></span></summary><div className="achievement-content"><select aria-label={label} value={profile.achievements[key] || 'Нет'} onChange={e => setProfile(p => ({ ...p, achievements: { ...p.achievements, [key]: e.target.value } }))}>{options.map(o => <option key={o}>{o}</option>)}</select><p>{hint}</p></div></details>)}</div>
        <label className="notes-label">Примечание к достижениям<textarea maxLength={1000} placeholder="Например: призёр олимпиады, название и год" value={profile.notes || ''} onChange={e => setProfile(p => ({ ...p, notes: e.target.value }))} /></label>
      </div><aside className="profile-summary"><div className="summary-symbol"><GraduationCap size={38} strokeWidth={1.3} /></div><span className="eyebrow">ТВОЯ ОТПРАВНАЯ ТОЧКА</span><div className="score-total">{sum}<span>баллов ЕГЭ</span></div><p>Сумма {profile.exams.length} предметов. Для конкурса вуз учитывает свой набор вступительных испытаний.</p><div className="summary-line"><MapPin size={17} /><span>{cityName || 'Вся Россия'}</span></div><div className="summary-line"><BookOpen size={17} /><span>{selectedSpecialty?.name || 'Все направления'}</span></div><div className="info-note"><Info size={17} /><p>Достижения проверяются отдельно. Прошлогодний проходной балл не гарантирует поступление.</p></div><button className="button button-dark full-width" disabled={pending} type="submit">{pending ? <><LoaderCircle className="spin" size={18} /> Подбираем…</> : <>Подобрать вуз <ArrowUpRight size={19} /></>}</button><p className="privacy-note">Данные анкеты сохраняются только в этом браузере.</p></aside></div>
      {error && <div role="alert" className="error-note"><Info size={20} /><div><strong>Давай проверим анкету</strong><p>{error}</p></div></div>}
    </form>
  </Modal>;
}

function Detail({ university: initial, city, saved, onSave, onClose }) {
  const [u, setU] = useState(initial);
  const [image, setImage] = useState(0);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    apiFetch(`/api/universities/${encodeURIComponent(initial.id)}`, { signal: controller.signal }).then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(data => { setU(data.university || initial); setNotice(data.notice || ''); }).catch(() => {});
    return () => controller.abort();
  }, [initial]);
  const website = safeUrl(u.website || u.web_pages?.[0]);
  return <Modal title={u.shortName || u.name} onClose={onClose} wide className="detail-modal">
    <div className="detail-gallery"><Photo photo={u.images?.[image]} title={u.name} className="detail-main-photo" loading="eager" /><div className="detail-image-overlay"><span className="tag"><MapPin size={14} />{city?.name || u.city || 'Россия'}</span><button className={`save-button ${saved ? 'saved' : ''}`} aria-label={saved ? 'Убрать из избранного' : 'В избранное'} onClick={() => onSave(u.id)} aria-pressed={saved}><Bookmark size={20} fill={saved ? 'currentColor' : 'none'} /></button></div></div>
    {u.images?.length > 1 && <div className="gallery-thumbs">{u.images.map((photo, i) => <button key={i} aria-label={`Фотография ${i + 1}`} className={image === i ? 'active' : ''} onClick={() => setImage(i)}><Photo photo={photo} title={u.name} /></button>)}</div>}
    <div className="detail-content"><div className="detail-main">{u.activeStatus === 'needs_verification' && <div className="info-note branch-notice"><Info size={17} /><p>Запись из справочника {u.sourceSnapshotYear || 2022} года. Действующий статус филиала, адрес и набор программ необходимо проверить на официальном сайте.</p></div>}<span className="eyebrow">ЗНАКОМИМСЯ БЛИЖЕ</span><h3>{u.name}</h3><div className="detail-tags">{(u.tags || []).map(t => <span key={t}>{t}</span>)}</div><p className="detail-lead">{u.description}</p>{(Array.isArray(u.details) ? u.details : [u.details]).filter(Boolean).map((p, i) => <p key={i}>{typeof p === 'string' ? p : p.text}</p>)}{u.programs?.length > 0 && <><h4>Направления подготовки</h4><div className="detail-tags">{u.programs.map(p => <span key={typeof p === 'string' ? p : p.code}>{typeof p === 'string' ? p : p.name}</span>)}</div></>}<p className="detail-source">Источник: {website ? <a href={website} target="_blank" rel="noopener noreferrer">официальный сайт вуза <ExternalLink size={12} /></a> : 'открытый каталог вузов'}. Условия приёма проверяй для своего года поступления.</p>{u.images?.[image]?.credit && <p className="image-credit">Фото: {u.images[image].credit}{safeUrl(u.images[image].source) && <> · <a href={u.images[image].source} target="_blank" rel="noopener noreferrer">источник</a></>}</p>}</div><aside className="detail-aside"><div className="small-illustration"><GraduationCap size={40} strokeWidth={1.3} /><Sparkles size={20} /></div><h4>Следующий шаг — знакомство</h4><p>Посмотри программы, вступительные испытания и правила приёма на официальном сайте.</p>{website && <a className="button button-dark full-width" href={website} target="_blank" rel="noopener noreferrer">На сайт вуза <ArrowUpRight size={17} /></a>}<div className="info-note"><Info size={16} /><p>Проходные баллы и стоимость не указаны без проверенного источника и года.</p></div></aside></div>
    {notice && <p className="detail-notice muted fine-print">{notice}</p>}
  </Modal>;
}

function Results({ result, cities, onClose, onOpen, onEdit }) {
  return <Modal title="Твоя подборка университетов" onClose={onClose} wide className="results-modal"><div className="results-intro"><div className="result-icon"><Compass size={32} /></div><div><span className="eyebrow">НАЧНЁМ С ЭТИХ ВАРИАНТОВ</span><p>Ты набрал(а) <strong>{result.totalScore} баллов ЕГЭ</strong>. Ниже — вузы для дальнейшего знакомства.</p></div></div><div className="info-note result-note"><Info size={18} /><p>{result.notice || 'Это предварительная подборка по интересам. Проходные баллы и льготы необходимо сверить с правилами приёма конкретной программы.'}</p></div><div className="recommendations">{(result.recommendations || []).map((r, index) => { const u = r.university; return <article key={u.id} className="recommendation"><Photo photo={u.images?.[0]} title={u.shortName || u.name} className="recommendation-photo" /><div className="recommendation-main"><span className="recommendation-number">ВАРИАНТ {String(index + 1).padStart(2, '0')} · {cities.find(c => c.id === u.cityId)?.name || u.city || 'Россия'}</span><h3>{u.shortName || u.name}</h3><p>{r.reason}</p>{r.passingScore ? <p className="passing-score">{r.passingScore.value} баллов · {r.passingScore.year} год · {r.passingScore.program}{safeUrl(sourceUrl(r.passingScore.source)) && <a href={sourceUrl(r.passingScore.source)} target="_blank" rel="noopener noreferrer">Источник <ExternalLink size={12} /></a>}</p> : <span className="unverified-label">Проходной балл требует проверки</span>}</div><button className="icon-button recommendation-open" onClick={() => onOpen(u)} aria-label={`Ознакомиться: ${u.name}`}><ArrowUpRight size={23} /></button></article>; })}{!result.recommendations?.length && <div className="empty-state"><Search size={30} /><h3>Пока нет подходящих записей</h3><p>Попробуй изменить направление или выбрать всю Россию.</p></div>}</div><button className="button button-outline" onClick={onEdit}><ArrowLeft size={17} /> Изменить анкету</button></Modal>;
}

function HowItWorks({ onClose, onStart }) {
  return <Modal title="Большой выбор. Твой путь." onClose={onClose}><p className="modal-subtitle">Сделай первый шаг к университету без лишней суеты.</p><div className="how-steps">{[['01', 'Выбери город', 'Смотри университеты по всей России или там, где хочешь учиться.'], ['02', 'Расскажи о себе', 'Добавь баллы ЕГЭ, интересное направление и свои достижения.'], ['03', 'Изучи варианты', 'Знакомься с вузами и сверяй условия приёма на официальных сайтах.']].map(([n, title, text]) => <div key={n}><span className="step-number">{n}</span><div><h3>{title}</h3><p>{text}</p></div></div>)}</div><div className="info-note"><Info size={18} /><p>Сейчас подбор работает по каталогу. Полное покрытие вузов и актуальные проходные баллы пока не подтверждены.</p></div><button className="button button-dark full-width" onClick={onStart}>Заполнить характеристики <ArrowUpRight size={18} /></button></Modal>;
}

export default function App() {
  const [catalog, setCatalog] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [retry, setRetry] = useState(0);
  const [selectedCity, setSelectedCity] = useStored('voooz-city', null);
  const [saved, setSaved] = useStored('voooz-saved', []);
  const [profile, setProfile] = useStored('voooz-profile', { exams: [{ subject: subjects[0], score: '' }, { subject: subjects[1], score: '' }, { subject: subjects[2], score: '' }], specialty: '', achievements: {}, notes: '' });
  const [modal, setModal] = useState(null);
  const [detail, setDetail] = useState(null);
  const [view, setView] = useState('catalog');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [sort, setSort] = useState('featured');
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState('');
  const [result, setResult] = useState(null);
  const [limit, setLimit] = useState(9);
  const city = catalog?.cities?.find(c => c.id === selectedCity);
  const closeModal = React.useCallback(() => setModal(null), []);
  const closeDetail = React.useCallback(() => setDetail(null), []);
  useEffect(() => {
    const controller = new AbortController();
    setLoadError('');
    apiFetch('/api/catalog', { signal: controller.signal }).then(async r => { if (!r.ok) throw new Error(); return r.json(); }).then(data => setCatalog(data)).catch(e => { if (e.name !== 'AbortError') setLoadError('Не получилось загрузить каталог. Проверь подключение и попробуй ещё раз.'); });
    return () => controller.abort();
  }, [retry]);
  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (!tg) return;
    tg.ready(); tg.expand();
    try { if (tg.isVersionAtLeast?.('6.1')) { tg.setHeaderColor('#f7f8f2'); tg.setBackgroundColor('#f7f8f2'); } } catch { /* older Telegram clients */ }
  }, []);
  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    const back = tg?.isVersionAtLeast?.('6.1') ? tg.BackButton : null;
    if (!back) return;
    const handler = () => { if (detail) setDetail(null); else if (modal) setModal(null); else setView('catalog'); };
    if (detail || modal || view !== 'catalog') back.show(); else back.hide();
    back.onClick(handler);
    return () => back.offClick(handler);
  }, [detail, modal, view]);
  useEffect(() => setLimit(9), [selectedCity, query, category, view]);
  useEffect(() => { if (catalog && selectedCity && !catalog.cities.some(c => c.id === selectedCity)) setSelectedCity(null); }, [catalog, selectedCity, setSelectedCity]);
  function toggleSaved(id) { setSaved(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]); }
  function showCatalog() { setView('catalog'); setTimeout(() => document.getElementById('universities')?.scrollIntoView({ behavior: 'smooth' }), 0); }
  function selectCity(id) { setSelectedCity(id); setModal(null); setView('catalog'); setTimeout(() => document.getElementById('universities')?.scrollIntoView({ behavior: 'smooth' }), 0); }
  function startProfile() { setFormError(''); setModal('profile'); }
  async function recommend() {
    if (pending) return;
    setFormError('');
    if (profile.exams.some(e => e.score === '' || !Number.isInteger(Number(e.score)) || Number(e.score) < 0 || Number(e.score) > 100)) { setFormError('Укажи целое число от 0 до 100 для каждого предмета.'); return; }
    setPending(true);
    try {
      const r = await apiFetch('/api/recommendations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...profile, city: selectedCity || undefined, exams: profile.exams.map(e => ({ ...e, score: Number(e.score) })) }), signal: AbortSignal.timeout(65000) });
      const data = await r.json();
      if (!r.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Не удалось получить подборку. Попробуй ещё раз.');
      setResult(data); setModal('results');
    } catch (e) { setFormError(e.name === 'TimeoutError' ? 'Подбор занял слишком много времени. Попробуй ещё раз.' : e.message || 'Не удалось получить подборку.'); }
    finally { setPending(false); }
  }
  const universities = useMemo(() => {
    let list = (catalog?.universities || []).filter(u => (!selectedCity || view === 'saved' || u.cityId === selectedCity) && (view !== 'saved' || saved.includes(u.id)));
    if (query) list = list.filter(u => normalize(`${u.name} ${u.shortName || ''} ${u.description || ''} ${(u.aliases || []).join(' ')} ${(u.tags || []).join(' ')}`).includes(normalize(query)));
    if (category !== 'all') list = list.filter(u => u.categories?.includes(category) || u.category === category || category === 'tech' && /техн|информ|инженер|IT|физик/i.test(`${u.description} ${(u.tags || []).join(' ')} ${u.name}`) || category === 'economics' && /эконом|менеджмент|бизнес/i.test(`${u.description} ${(u.tags || []).join(' ')} ${u.name}`) || category === 'medicine' && /медицин|врач/i.test(`${u.description} ${(u.tags || []).join(' ')} ${u.name}`) || category === 'humanities' && /гуманитар|филолог|социальн|истори/i.test(`${u.description} ${(u.tags || []).join(' ')} ${u.name}`) || category === 'science' && /физик|биолог|математ|хими/i.test(`${u.description} ${(u.tags || []).join(' ')} ${u.name}`) || category === 'creative' && /искусств|дизайн|творч|архитект/i.test(`${u.description} ${(u.tags || []).join(' ')} ${u.name}`));
    if (sort === 'name') list = [...list].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    return list;
  }, [catalog, selectedCity, view, saved, query, category, sort]);
  const heroUniversity = catalog?.universities?.find(u => /мгу|msu/i.test(`${u.id} ${u.shortName}`)) || catalog?.universities?.find(u => u.images?.length);
  return <>
    <header className="site-header"><div className="header-inner"><a href="#" className="brand" aria-label="ВОООЗ — на главную" onClick={e => { e.preventDefault(); setView('catalog'); window.scrollTo({ top: 0, behavior: 'smooth' }); }}><span className="brand-mark"><GraduationCap size={23} strokeWidth={1.8} /></span>воооз<span className="brand-dot">.</span></a><nav className="main-nav" aria-label="Главная навигация"><button className={view === 'catalog' ? 'active' : ''} onClick={showCatalog}>Каталог вузов</button><button onClick={() => setModal('how')}>Как это работает <ArrowUpRight size={13} /></button></nav><div className="header-actions"><button className="city-trigger" onClick={() => setModal('city')}><MapPin size={16} /><span>{city?.name || 'Город'}</span><ChevronDown size={14} /></button><span className="header-divider" /><button className={`header-saved ${view === 'saved' ? 'active' : ''}`} onClick={() => { setView(v => v === 'saved' ? 'catalog' : 'saved'); setCategory('all'); setQuery(''); setTimeout(() => document.getElementById('universities')?.scrollIntoView({ behavior: 'smooth' }), 0); }} aria-label="Избранное"><Bookmark size={19} /><span>Избранное</span>{saved.length > 0 && <b>{saved.length}</b>}</button></div></div></header>
    <main>
      {view === 'catalog' && <section className="hero container"><div className="hero-copy"><span className="hero-eyebrow"><span className="status-dot" /> БОЛЬШИЕ ПЛАНЫ НА БУДУЩЕЕ</span><h1>Твой вуз.<br />Твой выбор.<br /><em>Твоя история.</em></h1><p>Найди место, где твои интересы станут<br className="desktop-break" /> профессией. А мечты — планом на жизнь.</p><button className="button button-dark hero-cta" onClick={startProfile}>Подобрать мой вуз <ArrowUpRight size={20} /></button><div className="hero-journey" aria-label="Три шага к выбору вуза"><button onClick={() => setModal('city')}><span className="journey-step">01</span><span>Выбери<br /><strong>город</strong></span></button><ChevronRight size={13} aria-hidden="true" /><button onClick={startProfile}><span className="journey-step">02</span><span>Добавь<br /><strong>баллы ЕГЭ</strong></span></button><ChevronRight size={13} aria-hidden="true" /><button onClick={showCatalog}><span className="journey-step">03</span><span>Найди<br /><strong>свой вуз</strong></span></button></div></div><div className="hero-visual"><div className="hero-photo"><Photo photo={heroUniversity?.images?.[0]} title="Московский государственный университет" loading="eager" /><div className="hero-photo-gradient" /><div className="hero-photo-caption"><MapPin size={13} /><span>{heroUniversity?.shortName || 'Открой свой университет'}<small>{catalog?.cities?.find(c => c.id === heroUniversity?.cityId)?.name || 'Россия'}</small></span></div></div><span className="decorative-star star-one">✳</span><span className="decorative-star star-two">✦</span><div className="floating-note"><span className="floating-note-icon"><Compass size={24} strokeWidth={1.5} /></span><div>Там, где ты станешь собой<small>Найдём твоё направление</small></div><span className="note-dot" /></div><span className="vertical-note">У БУДУЩЕГО МНОГО АДРЕСОВ. НАЙДИ СВОЙ.</span><div className="photo-sticker"><GraduationCap size={26} strokeWidth={1.5} /><span>Всё только<br /><b>начинается!</b></span></div></div></section>}
      {view === 'catalog' && <div className="benefit-strip container"><span><Landmark size={19} />Университеты по всей России</span><i /><span><SlidersHorizontal size={19} />Подбор по твоим интересам</span><i /><span><Bookmark size={18} />Важное — в избранном</span><span className="strip-end">ВЫБИРАЙ ОСОЗНАННО <ArrowDown size={15} /></span></div>}
      <section className="catalog-section container" id="universities"><div className="catalog-heading"><div><span className="eyebrow">{view === 'saved' ? 'ТВОЙ ЛИЧНЫЙ СПИСОК' : selectedCity ? 'БЛИЖЕ К ТВОЕМУ БУДУЩЕМУ' : 'МЕСТО ДЛЯ БОЛЬШИХ ИДЕЙ'}</span><h2>{view === 'saved' ? 'Сохранено на будущее' : selectedCity ? `Университеты: ${city?.name || 'твой город'}` : 'Ведущие вузы России'}<span className="heading-period">.</span></h2><p>{view === 'saved' ? 'Те самые университеты, к которым хочется вернуться.' : selectedCity ? 'Знакомься с университетами выбранного города.' : 'Разные города и направления. Найди то, что откликается тебе.'}</p></div><button className="button button-outline characteristics-button" onClick={startProfile}><SlidersHorizontal size={17} /> Характеристики <ArrowUpRight size={16} /></button></div>
      <div className="catalog-controls"><label className="catalog-search"><Search size={19} /><input aria-label="Поиск вуза" placeholder="Название вуза или направление" value={query} onChange={e => setQuery(e.target.value)} />{query && <button className="icon-button small" onClick={() => setQuery('')} aria-label="Очистить поиск вузов"><X size={17} /></button>}</label><label className="sort-select"><span>Порядок:</span><select value={sort} onChange={e => setSort(e.target.value)} aria-label="Сортировка"><option value="featured">Выбор редакции</option><option value="name">По названию</option></select></label></div>
      <div className="category-tabs" role="group" aria-label="Направление обучения">{categories.map(([key, label]) => <button key={key} className={category === key ? 'active' : ''} onClick={() => setCategory(key)}>{key === 'all' && <Compass size={15} />}{label}</button>)}</div>
      <div className="catalog-meta"><span>{catalog ? `${universities.length} ${universities.length % 10 === 1 && universities.length % 100 !== 11 ? 'университет' : universities.length % 10 >= 2 && universities.length % 10 <= 4 && !(universities.length % 100 >= 12 && universities.length % 100 <= 14) ? 'университета' : 'университетов'}` : 'Загружаем университеты…'}{selectedCity && view !== 'saved' && <button onClick={() => setSelectedCity(null)} className="clear-city">{city?.name}<X size={12} /></button>}</span><span className="curation-note"><span className="status-dot" /> Редакционная подборка · не официальный рейтинг</span></div>
      {loadError ? <div className="empty-state" role="alert"><Info size={30} /><h3>Каталог пока недоступен</h3><p>{loadError}</p><button className="button button-dark" onClick={() => setRetry(n => n + 1)}>Попробовать снова</button></div> : !catalog ? <div className="loading-state" role="status"><LoaderCircle className="spin" size={28} /><p>Собираем места для твоего будущего…</p></div> : universities.length ? <><div className="university-grid">{universities.slice(0, limit).map((u, index) => <UniversityCard university={u} city={catalog.cities.find(c => c.id === u.cityId)} saved={saved.includes(u.id)} key={u.id} onSave={toggleSaved} onOpen={setDetail} index={index} />)}</div>{universities.length > limit && <div className="load-more"><button className="button button-outline" onClick={() => setLimit(n => n + 9)}>Ещё университеты <Plus size={18} /></button><span>Показано {Math.min(limit, universities.length)} из {universities.length}</span></div>}</> : <div className="empty-state"><Bookmark size={34} strokeWidth={1.3} /><h3>{view === 'saved' && !saved.length ? 'Твоё будущее пока на чистом листе' : 'По этим условиям вузов пока нет'}</h3><p>{view === 'saved' && !saved.length ? 'Нажми на закладку в карточке вуза — и он останется здесь.' : 'Попробуй другое название, направление или город. Каталог пока охватывает не все вузы России.'}</p><button className="button button-dark" onClick={() => { setView('catalog'); setQuery(''); setCategory('all'); setSelectedCity(null); }}>Смотреть все вузы <ArrowRight size={17} /></button></div>}
      {catalog && <p className="catalog-disclaimer"><Info size={14} />Каталог пополняется. Описания — для знакомства; актуальные программы и условия приёма проверяй на сайте вуза.</p>}
      </section>
      <section className="bottom-cta container"><div className="cta-orbit"><Compass size={48} strokeWidth={1.1} /><span>✦</span></div><div><span className="eyebrow">НЕ ЗНАЕШЬ, С ЧЕГО НАЧАТЬ?</span><h2>От твоих интересов —<br /><em>к твоему университету.</em></h2><p>Несколько ответов о себе. И чуть больше ясности впереди.</p></div><button className="button button-dark" onClick={startProfile}>Найти своё направление <ArrowUpRight size={20} /></button></section>
    </main>
    <footer className="site-footer container"><div><a href="#" className="brand" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>воооз<span className="brand-dot">.</span></a><p>Будущее начинается с выбора.</p></div><span>Сделано для тех, кто ищет своё.</span><button onClick={() => setModal('about')}>О проекте <ArrowUpRight size={14} /></button><span className="footer-year">© {new Date().getFullYear()} ВОООЗ</span></footer>
    <nav className="mobile-nav" aria-label="Мобильная навигация"><button className={view === 'catalog' ? 'active' : ''} onClick={showCatalog}><Landmark size={20} />Вузы</button><button onClick={startProfile}><Compass size={20} />Подбор</button><button className={view === 'saved' ? 'active' : ''} onClick={() => { setView('saved'); setCategory('all'); setQuery(''); document.getElementById('universities')?.scrollIntoView({ behavior: 'smooth' }); }}><Bookmark size={20} />Избранное{saved.length > 0 && <i>{saved.length}</i>}</button></nav>
    {modal === 'city' && <CityPicker cities={catalog?.cities || []} selected={selectedCity} onSelect={selectCity} onClose={closeModal} />}
    {modal === 'profile' && catalog && <Profile catalog={catalog} profile={profile} setProfile={setProfile} onClose={closeModal} onSubmit={recommend} pending={pending} error={formError} cityName={city?.name} />}
    {modal === 'profile' && !catalog && <Modal title="Каталог загружается" onClose={closeModal}><p className="modal-subtitle">{loadError || 'Подожди немного: сначала нужно загрузить каталог направлений.'}</p></Modal>}
    {modal === 'results' && result && <Results result={result} cities={catalog?.cities || []} onClose={closeModal} onOpen={u => { setModal(null); setDetail(u); }} onEdit={startProfile} />}
    {modal === 'how' && <HowItWorks onClose={closeModal} onStart={startProfile} />}
    {modal === 'about' && <Modal title="ВОООЗ — пространство выбора" onClose={closeModal}><p className="modal-subtitle">Помогаем познакомиться с университетами России и сделать первый шаг к своей профессии.</p><div className="about-content"><p>В каталоге сейчас {catalog?.universities?.length || 0} вузов и {catalog?.cities?.length || 0} городов. Поиск специальностей включает {catalog?.specialties?.length || 0} направлений высшего образования.</p><p>Это развивающийся каталог, а не полный реестр или официальный рейтинг. Подбор предварительный и не оценивает вероятность поступления. Нейросеть пока не подключена.</p><p>Баллы ЕГЭ, избранное и выбранный город хранятся локально в браузере. {standaloneMode ? 'В этой версии анкета обрабатывается на устройстве, без отправки на сервер.' : 'При подборе анкета передаётся серверу приложения.'} Достижения не превращаются в баллы без правил конкретного вуза.</p>{catalog?.meta?.sources?.length > 0 && <><h3>Источники каталога</h3><ul>{catalog.meta.sources.map((s, i) => { const url = safeUrl(typeof s === 'string' ? s : s.url); return <li key={i}>{url ? <a href={url} target="_blank" rel="noopener noreferrer">{s.name || s.title || new URL(url).hostname} <ExternalLink size={12} /></a> : typeof s === 'string' ? s : s.name || s.title}</li>; })}</ul></>}</div></Modal>}
    {detail && <Detail university={detail} city={catalog?.cities.find(c => c.id === detail.cityId)} saved={saved.includes(detail.id)} onSave={toggleSaved} onClose={closeDetail} />}
  </>;
}
