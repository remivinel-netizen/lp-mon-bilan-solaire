/* Worker devant les fichiers statiques.
 *
 * Il n'existe que pour la validation du numéro de téléphone par code SMS.
 * Deux choses ne doivent jamais descendre dans le navigateur : la clé du
 * fournisseur de SMS, et le code à 6 chiffres lui-même. Les deux restent ici.
 * Tout le reste est délégué au moteur d'assets, exactement comme avant.
 *
 * Secrets (npx wrangler secret put …) :
 *   SMS_USERNAME  identifiant ClickSend
 *   SMS_API_KEY   clé API ClickSend
 *   SMS_SENDER    optionnel : nom d'expéditeur déclaré, sinon numéro partagé
 *
 * Stockage : espace KV « mbs-codes-sms », lié sous le nom CODES.
 */

/* Départements où le numéro est validé par code. Recalculés côté serveur à
   partir du code postal : la page ne décide pas qui passe par la validation. */
const DEPTS = ['01', '38', '42', '69'];

const MOBILE = /^\+33[67]\d{8}$/;

const VALIDITE = 600;        /* 10 minutes de vie pour un code */
const ESSAIS_MAX = 5;        /* essais par code, puis le code est détruit */
const ENVOIS_MAX = 3;        /* codes envoyés par numéro et par heure */
const FENETRE_ENVOIS = 3600;

const vide = (statut) => new Response(null, { status: statut });
const parle = (statut, corps) => new Response(JSON.stringify(corps), {
  status: statut, headers: { 'Content-Type': 'application/json' }
});

function maintenant() { return Math.floor(Date.now() / 1000); }

/* Tirage uniforme des 6 chiffres. Le rejet des dernières valeurs écarte le
   biais du modulo, qui rendrait les premiers codes plus probables que les
   autres — un code devinable n'est pas un code. */
function genereCode() {
  const limite = Math.floor(0xffffffff / 1000000) * 1000000;
  const tampon = new Uint32Array(1);
  let v;
  do { crypto.getRandomValues(tampon); v = tampon[0]; } while (v >= limite);
  return String(v % 1000000).padStart(6, '0');
}

async function lisJson(request) {
  try { return await request.json(); } catch (e) { return null; }
}

/* Écarte les appels venant d'un autre site. Faible en soi — un en-tête se
   falsifie — mais gratuit. */
function bonneOrigine(request, url) {
  const origine = request.headers.get('Origin');
  if (!origine) return true;
  try { return new URL(origine).hostname === url.hostname; } catch (e) { return false; }
}

/* Combien de codes ce numéro a-t-il demandés dans l'heure écoulée. La fenêtre
   est ouverte par le premier envoi et ne glisse pas : sinon un demandeur
   patient la repousserait indéfiniment. */
async function compteEnvois(env, tel) {
  const cle = 'envois:' + tel;
  const suivi = await env.CODES.get(cle, 'json');
  const t = maintenant();

  if (!suivi || t - suivi.t0 >= FENETRE_ENVOIS) {
    await env.CODES.put(cle, JSON.stringify({ n: 1, t0: t }), { expirationTtl: FENETRE_ENVOIS });
    return 1;
  }
  const n = suivi.n + 1;
  const reste = suivi.t0 + FENETRE_ENVOIS - t;
  /* 60 s est le minimum accepté par KV pour une expiration. */
  await env.CODES.put(cle, JSON.stringify({ n: n, t0: suivi.t0 }),
    { expirationTtl: Math.max(60, reste) });
  return n;
}

async function envoieSms(env, tel, corps, dept) {
  const message = { body: corps, to: tel };
  if (env.SMS_SENDER) message.from = env.SMS_SENDER;

  let r, brut;
  try {
    r = await fetch('https://rest.clicksend.com/v3/sms/send', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(env.SMS_USERNAME + ':' + env.SMS_API_KEY),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ messages: [message] })
    });
    brut = await r.text();
  } catch (e) {
    console.error('ClickSend injoignable', String(e).slice(0, 200));
    return false;
  }

  /* Tout est tracé dans les logs du Worker (observability est activée), succès
     comme échec — sinon rien ne distingue un SMS parti d'un SMS écarté par un
     filtre. Jamais le numéro ni le code dans les logs : ce n'est ni un fichier
     de prospects, ni un trousseau. */
  if (!r.ok) { console.error('ClickSend HTTP', r.status, brut.slice(0, 300)); return false; }

  /* ClickSend répond 200 même quand il refuse le message : le verdict est dans
     messages[0].status. */
  let m = null;
  try { m = JSON.parse(brut).data.messages[0]; } catch (e) {}
  if (!m) { console.error('ClickSend reponse inattendue', brut.slice(0, 300)); return false; }
  if (m.status !== 'SUCCESS') { console.error('ClickSend refus', m.status, 'dept=' + dept); return false; }

  /* message_parts vaut 1 si le texte tient dans un seul SMS ; message_price
     permet de suivre le coût réel. */
  console.log('code envoye', 'dept=' + dept, 'parts=' + m.message_parts,
              'prix=' + m.message_price, 'id=' + m.message_id);
  return true;
}

/* POST /api/sms/code — envoie un code à 6 chiffres au numéro. */
async function demandeCode(request, env) {
  const d = await lisJson(request);
  if (!d) return vide(400);

  const cp = String(d.code_postal || '');
  const dept = cp.slice(0, 2);
  const tel = String(d.telephone_e164 || '');

  if (!/^\d{5}$/.test(cp) || !MOBILE.test(tel)) return vide(400);
  /* Hors périmètre : la page n'aurait pas dû appeler. On refuse plutôt que de
     répondre 204, pour qu'un défaut de câblage se voie. */
  if (DEPTS.indexOf(dept) === -1) return vide(400);

  if (await compteEnvois(env, tel) > ENVOIS_MAX) return parle(429, { raison: 'trop_d_envois' });

  const code = genereCode();
  await env.CODES.put('code:' + tel,
    JSON.stringify({ c: code, e: 0, exp: maintenant() + VALIDITE }),
    { expirationTtl: VALIDITE });

  const parti = await envoieSms(env, tel,
    'Mon Bilan Solaire : votre code de validation est ' + code + '. Il expire dans 10 minutes.',
    dept);
  /* 503 est un message adressé à la page : le fournisseur est en panne, laisse
     passer le lead plutôt que de le perdre. */
  if (!parti) return parle(503, { raison: 'fournisseur' });

  return vide(204);
}

/* POST /api/sms/verifie — confronte le code saisi à celui qui a été envoyé. */
async function verifieCode(request, env) {
  const d = await lisJson(request);
  if (!d) return vide(400);

  const tel = String(d.telephone_e164 || '');
  const saisi = String(d.code || '').replace(/\D/g, '');
  if (!MOBILE.test(tel) || saisi.length !== 6) return vide(400);

  const cle = 'code:' + tel;
  const dossier = await env.CODES.get(cle, 'json');
  if (!dossier || dossier.exp <= maintenant()) {
    if (dossier) await env.CODES.delete(cle);
    return parle(410, { raison: 'expire' });
  }

  if (dossier.c === saisi) {
    /* Usage unique : le code meurt à la première réussite. */
    await env.CODES.delete(cle);
    return vide(204);
  }

  const essais = dossier.e + 1;
  if (essais >= ESSAIS_MAX) {
    await env.CODES.delete(cle);
    return parle(410, { raison: 'essais' });
  }
  /* On garde l'expiration d'origine : un code ne doit pas gagner du temps de
     vie à chaque erreur de frappe. */
  await env.CODES.put(cle, JSON.stringify({ c: dossier.c, e: essais, exp: dossier.exp }),
    { expirationTtl: Math.max(60, dossier.exp - maintenant()) });
  return parle(400, { raison: 'faux', restants: ESSAIS_MAX - essais });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/sms/code' || url.pathname === '/api/sms/verifie') {
      if (request.method !== 'POST') return vide(405);
      if (!bonneOrigine(request, url)) return vide(403);
      return url.pathname === '/api/sms/code'
        ? demandeCode(request, env)
        : verifieCode(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};
