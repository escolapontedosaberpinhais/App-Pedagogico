// Vercel Cron Job — executa todo dia às 05:00 UTC (02:00 horário de Brasília)
// Lê todos os dados do Firestore e salva um JSON de backup no Google Drive.
//
// Variáveis de ambiente necessárias no Vercel:
//   FIREBASE_WEB_API_KEY  — chave web do Firebase (já existe no app)
//   GDRIVE_SA_JSON        — conteúdo do JSON da conta de serviço do Google
//   GDRIVE_FOLDER_ID      — ID da pasta no Google Drive onde salvar os backups
//   CRON_SECRET           — (opcional) se definida, protege o endpoint
//
// TESTE MANUAL: abra no navegador
//   https://SEU-DOMINIO.vercel.app/api/backup-cron
// e veja o JSON de diagnóstico com o resultado de cada etapa.

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
    scope: 'https://www.googleapis.com/auth/drive',
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

  // supportsAllDrives=true permite gravar em pastas de Drives compartilhados
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true', {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${BOUNDARY}`,
    },
    body,
  });
  return r.json();
}

// ── Interpreta o JSON da conta de serviço, tolerante a problemas de paste ────
// Tenta várias formas: JSON puro, base64, aspas externas acidentais, ou com o
// caractere "{" inicial perdido no paste. Retorna o 1º candidato válido que
// tenha private_key + client_email.
function parseServiceAccount(raw) {
  const s = (raw || '').trim();
  const candidatos = [s];

  // Sem aspas externas acidentais (valor colado entre aspas)
  if (s.length > 1 && s[0] === '"' && s[s.length - 1] === '"') candidatos.push(s.slice(1, -1).trim());
  if (s.length > 1 && s[0] === "'" && s[s.length - 1] === "'") candidatos.push(s.slice(1, -1).trim());

  // "{" inicial perdido no paste (começa com "type": ... e termina com })
  if (!s.startsWith('{') && s.endsWith('}')) candidatos.push('{' + s);

  // Conteúdo em base64
  try {
    const dec = Buffer.from(s, 'base64').toString('utf8').trim();
    if (dec.startsWith('{')) candidatos.push(dec);
  } catch { /* ignora */ }

  let ultimoErro;
  for (const c of candidatos) {
    try {
      const obj = JSON.parse(c);
      if (obj && obj.private_key && obj.client_email) return obj;
    } catch (e) { ultimoErro = e; }
  }
  throw ultimoErro || new Error('JSON da conta de serviço não pôde ser interpretado');
}

// ── Handler principal ────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Autenticação: só exige o segredo se ele estiver configurado.
  // O Vercel só envia o header Authorization quando CRON_SECRET existe como env var;
  // sem ela, a checagem antiga travava TUDO com 401. Agora, sem segredo, o cron roda
  // e o endpoint também pode ser testado manualmente pelo navegador.
  if (CRON_SECRET) {
    const auth = req.headers.authorization;
    const viaQuery = req.query?.secret === CRON_SECRET;
    if (auth !== `Bearer ${CRON_SECRET}` && !viaQuery) {
      return res.status(401).json({ error: 'Não autorizado' });
    }
  }

  // Diagnóstico passo a passo — visível ao abrir a URL no navegador.
  const diag = {
    ok: false,
    etapa: 'início',
    env: {
      FIREBASE_WEB_API_KEY: !!API_KEY,
      GDRIVE_SA_JSON:       !!SA_JSON,
      GDRIVE_FOLDER_ID:     !!FOLDER_ID,
      CRON_SECRET:          !!CRON_SECRET,
    },
  };

  const faltando = [];
  if (!SA_JSON)   faltando.push('GDRIVE_SA_JSON');
  if (!FOLDER_ID) faltando.push('GDRIVE_FOLDER_ID');
  if (!API_KEY)   faltando.push('FIREBASE_WEB_API_KEY');
  if (faltando.length) {
    diag.etapa = 'variáveis de ambiente';
    diag.error = 'Variáveis não configuradas no Vercel: ' + faltando.join(', ');
    return res.status(500).json(diag);
  }

  try {
    // 1. Interpretar o JSON da conta de serviço
    diag.etapa = 'ler GDRIVE_SA_JSON';
    let sa;
    try {
      sa = parseServiceAccount(SA_JSON);
    } catch (e) {
      const t = (SA_JSON || '').trim();
      diag.error = 'GDRIVE_SA_JSON não é um JSON válido. Cole o conteúdo inteiro do arquivo .json da conta de serviço (ou o mesmo conteúdo em base64).';
      // Pistas seguras (não revelam a chave privada) para diagnóstico:
      diag.parseErro     = e.message;
      diag.tamanho       = t.length;
      diag.primeiroChar  = t[0] || '(vazio)';
      diag.ultimoChar    = t[t.length - 1] || '(vazio)';
      diag.comecaComChave = t.startsWith('{');
      diag.terminaComChave = t.endsWith('}');
      return res.status(500).json(diag);
    }
    diag.contaServico = sa.client_email || '(sem client_email)';
    if (!sa.private_key || !sa.client_email) {
      diag.etapa = 'validar GDRIVE_SA_JSON';
      diag.error = 'O JSON da conta de serviço não tem private_key/client_email. Use o arquivo de CHAVE (JSON) da conta, não outro arquivo.';
      return res.status(500).json(diag);
    }

    // 2. Obter token OAuth do Google
    diag.etapa = 'autenticar no Google (JWT → token)';
    const token = await getGoogleToken(sa);
    diag.tokenObtido = true;

    // 3. Ler todas as coleções do Firestore
    diag.etapa = 'ler Firestore';
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
    diag.colecoesColetadas = coletados;

    // 4. Nome do arquivo com data BRT (AAAA-MM-DD)
    const dataBrt = new Date().toLocaleDateString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).split('/').reverse().join('-');
    const filename = `backup_pedagogico_${dataBrt}.json`;

    // 5. Upload para o Google Drive
    diag.etapa = 'enviar para o Google Drive';
    const result = await uploadDrive(token, filename, JSON.stringify(backup, null, 2), FOLDER_ID);
    if (result.error) {
      diag.error = 'Google Drive recusou o upload: ' + JSON.stringify(result.error);
      diag.dica = 'Verifique se a pasta foi COMPARTILHADA com a conta de serviço (' + diag.contaServico + ') como Editor, e se o GDRIVE_FOLDER_ID está correto.';
      return res.status(500).json(diag);
    }

    diag.ok       = true;
    diag.etapa    = 'concluído';
    diag.arquivo  = filename;
    diag.driveId  = result.id;
    return res.status(200).json(diag);
  } catch (e) {
    diag.error = e.message;
    return res.status(500).json(diag);
  }
}
