// Vercel Cron Job — executa todo dia às 05:00 UTC (02:00 horário de Brasília)
// Lê todos os dados do Firestore e salva um JSON de backup no Google Drive.
//
// Variáveis de ambiente necessárias no Vercel:
//   FIREBASE_WEB_API_KEY  — chave web do Firebase (já existe no app)
//   GDRIVE_SA_JSON        — conteúdo do JSON da conta de serviço do Google
//   GDRIVE_FOLDER_ID      — ID da pasta no Google Drive onde salvar os backups

import { createSign } from 'node:crypto';

const PROJECT_ID  = 'escola-ponte-saber';
const API_KEY     = process.env.FIREBASE_WEB_API_KEY;
const SA_JSON     = process.env.GDRIVE_SA_JSON;
const FOLDER_ID   = process.env.GDRIVE_FOLDER_ID;
const CRON_SECRET = process.env.CRON_SECRET;

// Coleções do Firestore (documentos dentro de /appdata/)
const DOCS = [
  'turmas', 'alunos', 'planejamentos', 'pareceres',
  'avaliacoes', 'usuarios', 'chatGeral', 'horaAtividade',
  'rotinas', 'config', 'ocorrencias', 'agendaFormacao',
  'notificacoes',
];

// ── Converte valor Firestore REST → JavaScript puro ──────────────────────────
function fromFsValue(v) {
  if (!v) return null;
  if ('stringValue'  in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue'  in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue'    in v) return null;
  if ('arrayValue'   in v) return (v.arrayValue.values || []).map(fromFsValue);
  if ('mapValue'     in v) {
    const out = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) out[k] = fromFsValue(val);
    return out;
  }
  return null;
}

// ── Lê um documento do Firestore via REST ────────────────────────────────────
async function lerDoc(docId) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/appdata/${docId}?key=${API_KEY}`;
  const r = await fetch(url);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Firestore ${docId}: HTTP ${r.status}`);
  const j = await r.json();
  if (!j.fields?.data) return null;
  return fromFsValue(j.fields.data);
}

// ── Gera token OAuth2 para conta de serviço do Google ───────────────────────
async function getGoogleToken(sa) {
  const now     = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss:   sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive.file',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  })).toString('base64url');

  const sign = createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(sa.private_key, 'base64url');
  const jwt = `${header}.${payload}.${sig}`;

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Falha ao obter token Google: ' + JSON.stringify(d));
  return d.access_token;
}

// ── Faz upload de arquivo JSON para o Google Drive ───────────────────────────
async function uploadDrive(token, filename, content, folderId) {
  const BOUNDARY = 'backup_bnd_escola';
  const meta = JSON.stringify({ name: filename, parents: [folderId] });
  const body = [
    `--${BOUNDARY}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    meta,
    `--${BOUNDARY}`,
    'Content-Type: application/json',
    '',
    content,
    `--${BOUNDARY}--`,
  ].join('\r\n');

  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${BOUNDARY}`,
    },
    body,
  });
  return r.json();
}

// ── Handler principal ────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Vercel envia Authorization: Bearer {CRON_SECRET} nas chamadas cron
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Não autorizado' });
  }

  const erros = [];
  if (!SA_JSON)    erros.push('GDRIVE_SA_JSON não configurada');
  if (!FOLDER_ID)  erros.push('GDRIVE_FOLDER_ID não configurada');
  if (!API_KEY)    erros.push('FIREBASE_WEB_API_KEY não configurada');
  if (erros.length) return res.status(500).json({ error: erros.join('; ') });

  try {
    // 1. Obter token do Google Drive
    const sa    = JSON.parse(SA_JSON);
    const token = await getGoogleToken(sa);

    // 2. Ler todas as coleções do Firestore em paralelo
    const resultados = await Promise.allSettled(DOCS.map(d => lerDoc(d).then(v => ({ d, v }))));
    const backup = {
      exportadoEm: new Date().toISOString(),
      fonte:       'backup-automatico-vercel',
      versaoApp:   'v2.9.35',
    };
    let coletados = 0;
    for (const r of resultados) {
      if (r.status === 'fulfilled' && r.value.v !== null) {
        backup[r.value.d] = r.value.v;
        coletados++;
      }
    }

    // 3. Nome do arquivo com data BRT (AAAA-MM-DD)
    const dataBrt = new Date().toLocaleDateString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).split('/').reverse().join('-');
    const filename = `backup_pedagogico_${dataBrt}.json`;

    // 4. Upload para o Google Drive
    const result = await uploadDrive(token, filename, JSON.stringify(backup, null, 2), FOLDER_ID);
    if (result.error) throw new Error('Drive: ' + JSON.stringify(result.error));

    return res.status(200).json({
      ok:        true,
      arquivo:   filename,
      driveId:   result.id,
      colecoes:  coletados,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
