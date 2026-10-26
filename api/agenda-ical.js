// Agenda do Calendário Escolar em formato iCal (.ics), para assinar no
// Google Agenda (Outras agendas → "A partir do URL"), Outlook ou celular.
//
//   https://SEU-DOMINIO.vercel.app/api/agenda-ical?t=TOKEN            → tudo (inclui eventos internos)
//   https://SEU-DOMINIO.vercel.app/api/agenda-ical?t=TOKEN&so=internos → só os eventos internos
//
// O TOKEN é gerado pela direção no Calendário Escolar do app e fica em
// appdata/config.icalToken. Sem token válido a resposta é 404, sem dizer por quê.
// Gerar um link novo no app invalida o anterior.
//
// O Google relê a agenda assinada sozinho, em geral algumas vezes por dia:
// uma mudança no app pode levar horas para aparecer lá.

import { timingSafeEqual } from 'node:crypto';

const PROJECT_ID = 'escola-ponte-saber';
// A chave web do Firebase já é pública (está no index.html); a variável de
// ambiente, quando existe, tem preferência.
const API_KEY = process.env.FIREBASE_WEB_API_KEY || 'AIzaSyBdr7KI6o_Cy9fJ4mRwA2bkLQWssGCm1yE';

const TIPOS = {
  feriado: 'Feriado', recesso: 'Recesso Escolar', colonia: 'Colônia de Férias',
  formacao: 'Formação', vox_dei: 'Vox Dei', inicio_bimestre: 'Início de Período',
  fim_bimestre: 'Fim de Período', entrega_parecer: 'Entrega de Pareceres',
  reuniao_pais: 'Reunião de Pais', comemoracao: 'Comemoração', simulado: 'Simulado',
  evento: 'Evento Escolar',
};
const DIAS_ICS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

// ── Firestore REST → JavaScript ──────────────────────────────────────────
function fromFs(v) {
  if (!v) return null;
  if ('stringValue' in v)  return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v)  return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v)    return null;
  if ('arrayValue' in v)   return (v.arrayValue.values || []).map(fromFs);
  if ('mapValue' in v) {
    const o = {};
    for (const [k, x] of Object.entries(v.mapValue.fields || {})) o[k] = fromFs(x);
    return o;
  }
  return null;
}

async function lerDoc(id) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/appdata/${id}?key=${API_KEY}`;
  const r = await fetch(url);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Firestore ${id}: HTTP ${r.status}`);
  const j = await r.json();
  const o = {};
  for (const [k, x] of Object.entries(j.fields || {})) o[k] = fromFs(x);
  return o;
}

// ── iCal ─────────────────────────────────────────────────────────────────
// Data AAAA-MM-DD que existe no calendario (13/40 quebraria a agenda inteira no Google)
function ehData(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return t.getUTCFullYear() === +m[1] && t.getUTCMonth() === +m[2] - 1 && t.getUTCDate() === +m[3];
}
const icsData = iso => String(iso).replace(/-/g, '');
function diaSeguinte(iso) {
  const [a, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(a, m - 1, d + 1));
  return t.toISOString().slice(0, 10);
}
// Texto do iCal: barra, ponto e vírgula, vírgula e quebra de linha escapados
const icsTexto = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// Linhas de no máximo 75 bytes; a continuação começa com um espaço
function dobrar(linha) {
  const partes = [];
  let atual = '', bytes = 0;
  for (const ch of linha) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (partes.length ? 74 : 75)) { partes.push(atual); atual = ''; bytes = 0; }
    atual += ch; bytes += b;
  }
  partes.push(atual);
  return partes.join('\r\n ');
}

function eventoIcs({ uid, inicio, fimExclusivo, titulo, descricao, categoria, rrule, carimbo }) {
  const l = [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${carimbo}`,
    `DTSTART;VALUE=DATE:${icsData(inicio)}`,
    `DTEND;VALUE=DATE:${icsData(fimExclusivo)}`,
    `SUMMARY:${icsTexto(titulo)}`,
  ];
  if (rrule) l.push(`RRULE:${rrule}`);
  if (descricao) l.push(`DESCRIPTION:${icsTexto(descricao)}`);
  if (categoria) l.push(`CATEGORIES:${icsTexto(categoria)}`);
  l.push('TRANSP:TRANSPARENT', 'END:VEVENT');
  return l;
}

// Monta o .ics a partir do documento calendarioEscolar ({ ano, eventos, recorrentes })
export function montarIcs(cal, { soInternos = false, agora = new Date() } = {}) {
  const carimbo = agora.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const ano = Number(cal?.ano) || agora.getUTCFullYear();
  const linhas = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Escola Ponte do Saber//App Pedagogico//PT-BR',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${soInternos ? 'Ponte do Saber — agenda interna' : 'Ponte do Saber — calendário escolar'}`,
    'X-WR-TIMEZONE:America/Sao_Paulo',
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H', 'X-PUBLISHED-TTL:PT6H',
  ];
  for (const e of (cal?.eventos || [])) {
    if (!e || (soInternos && !e.interno)) continue;
    const inicio = ehData(e.data) ? e.data : e.dataInicio;
    const fim = ehData(e.data) ? e.data : e.dataFim;
    if (!ehData(inicio) || !ehData(fim) || fim < inicio) continue;
    const tipo = TIPOS[e.tipo] || 'Evento';
    linhas.push(...eventoIcs({
      uid: `cal-${ano}-${e.id}@ponte-do-saber`, inicio, fimExclusivo: diaSeguinte(fim), carimbo,
      titulo: (e.interno ? '🔒 ' : '') + (e.descricao || tipo),
      descricao: tipo + (e.interno ? ' · uso interno da equipe' : ''), categoria: tipo,
    }));
  }
  // Marcacoes semanais (ex.: Vox Dei toda quarta): um evento que se repete
  if (!soInternos) {
    for (const r of (cal?.recorrentes || [])) {
      const dow = Number(r?.diaSemana);
      if (!r || !(dow >= 0 && dow <= 6)) continue;
      let inicio = ehData(r.inicio) ? r.inicio : `${ano}-01-01`;
      const fim = ehData(r.fim) ? r.fim : `${ano}-12-31`;
      // primeira ocorrencia no dia da semana certo
      for (let i = 0; i < 7 && new Date(inicio + 'T12:00:00Z').getUTCDay() !== dow; i++) inicio = diaSeguinte(inicio);
      if (inicio > fim) continue;
      const tipo = TIPOS[r.tipo] || 'Evento';
      linhas.push(...eventoIcs({
        uid: `rec-${ano}-${r.id}@ponte-do-saber`, inicio, fimExclusivo: diaSeguinte(inicio), carimbo,
        titulo: r.descricao || tipo, descricao: tipo + ' · toda semana', categoria: tipo,
        rrule: `FREQ=WEEKLY;BYDAY=${DIAS_ICS[dow]};UNTIL=${icsData(fim)}`,
      }));
    }
  }
  linhas.push('END:VCALENDAR');
  return linhas.map(dobrar).join('\r\n') + '\r\n';
}

export default async function handler(req, res) {
  const token = String(req.query?.t || '');
  try {
    const config = await lerDoc('config');
    const certo = String(config?.icalToken || '');
    // Comparacao em tempo constante; token curto ou ausente nunca vale
    const ok = certo.length >= 24 && token.length === certo.length
      && timingSafeEqual(Buffer.from(token), Buffer.from(certo));
    if (!ok) { res.status(404).send('Agenda não encontrada.'); return; }
    const doc = await lerDoc('calendarioEscolar');
    const ics = montarIcs(doc?.data || null, { soInternos: req.query?.so === 'internos' });
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="ponte-do-saber.ics"');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.status(200).send(ics);
  } catch (e) {
    res.status(502).send('Não foi possível montar a agenda agora.');
  }
}
