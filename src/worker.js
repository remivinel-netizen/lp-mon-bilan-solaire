/* Worker devant les fichiers statiques.
 *
 * Il n'existe que pour une chose : envoyer le SMS de confirmation sans que la
 * clé ClickSend passe par le navigateur. Tout le reste est délégué au moteur
 * d'assets, exactement comme avant (URL sans extension, _headers, page 404).
 *
 * Secrets attendus (npx wrangler secret put …) :
 *   SMS_USERNAME  nom d'utilisateur ClickSend
 *   SMS_API_KEY   clé API ClickSend
 *   SMS_SENDER    optionnel : nom d'expéditeur déclaré, sinon numéro partagé
 */

/* Départements où le SMS est envoyé. Recalculés côté serveur à partir du code
   postal : le client ne décide pas s'il a droit à un SMS. */
const DEPTS = ['01', '38', '42', '69'];

/* Départements réellement couverts par un installateur. Le 69 n'en fait pas
   partie : la page de remerciement hors zone lui annonce qu'il ne sera pas
   rappelé, le SMS ne doit donc pas promettre l'inverse. Doit rester aligné
   sur la constante ZONE de index.html. */
const ZONE = ['01', '03', '04', '05', '07', '13', '21', '25', '26', '30', '34',
              '38', '39', '42', '43', '63', '70', '73', '74', '84', '90'];

const MOBILE = /^\+33[67]\d{8}$/;

function texte(prenom, couverte) {
  const qui = prenom ? 'Bonjour ' + prenom + ', v' : 'V';
  return couverte
    ? qui + 'otre demande de bilan solaire est enregistree. EKO HABITATIONS vous appelle sous 48h ouvrees. Mon Bilan Solaire'
    : qui + 'otre demande de bilan solaire est enregistree. Nous verifions si un installateur intervient dans votre secteur. Mon Bilan Solaire';
}

/* Le prénom est réduit à de l'ASCII : accents dépliés, le reste écarté. Deux
   raisons. Un caractère hors GSM-7 (un ō, un emoji) basculerait tout le message
   en UCS-2, donc 70 caractères par SMS au lieu de 160 — trois SMS facturés au
   lieu d'un. Et on ne garde que le premier mot, plafonné à 18 caractères :
   « Marie-Ange Bénédicte » devient « Marie-Ange » plutôt qu'un mot coupé en
   deux, et même un « Jean-Christophe » laisse le message sous 160. */
function nettoiePrenom(brut) {
  return String(brut || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z '-]/g, ' ')
    .trim().split(/\s+/)[0].slice(0, 18);
}

/* Garde-fou : un même numéro ne reçoit qu'un SMS par heure. Le cache est local
   au datacenter, donc ce n'est pas une barrière absolue — il arrête les
   double-soumissions et les boucles naïves. La vraie limite de débit se règle
   par une règle Cloudflare Rate Limiting, et le plafond de dépense chez
   ClickSend. */
async function dejaEnvoye(tel) {
  const cle = new Request('https://sms-garde.invalid/' + encodeURIComponent(tel));
  const cache = caches.default;
  if (await cache.match(cle)) return true;
  await cache.put(cle, new Response('1', { headers: { 'Cache-Control': 'max-age=3600' } }));
  return false;
}

async function envoie(env, tel, corps) {
  const message = { body: corps, to: tel };
  if (env.SMS_SENDER) message.from = env.SMS_SENDER;

  const r = await fetch('https://rest.clicksend.com/v3/sms/send', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + btoa(env.SMS_USERNAME + ':' + env.SMS_API_KEY),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ messages: [message] })
  });
  /* Tracé dans les logs du Worker (observability est activée) : sans ça, un SMS
     qui ne part pas est invisible. */
  if (!r.ok) console.error('ClickSend', r.status, (await r.text()).slice(0, 300));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/sms') {
      if (request.method !== 'POST') return new Response(null, { status: 405 });

      /* Ne répond qu'aux appels venant du site. Faible en soi — un en-tête se
         falsifie — mais écarte les appels depuis un autre site. */
      const origine = request.headers.get('Origin');
      if (origine && new URL(origine).hostname !== url.hostname) {
        return new Response(null, { status: 403 });
      }

      let d;
      try { d = await request.json(); } catch (e) { return new Response(null, { status: 400 }); }

      const cp = String(d.code_postal || '');
      const dept = cp.slice(0, 2);
      const tel = String(d.telephone_e164 || '');

      if (!/^\d{5}$/.test(cp) || !MOBILE.test(tel)) return new Response(null, { status: 400 });
      /* Hors périmètre : on répond 204 sans rien envoyer. Pas 403 : ce n'est
         pas une erreur du client, simplement un lead sans SMS. */
      if (DEPTS.indexOf(dept) === -1) return new Response(null, { status: 204 });

      if (await dejaEnvoye(tel)) return new Response(null, { status: 204 });

      const prenom = nettoiePrenom(d.prenom);
      /* waitUntil : on répond tout de suite, l'appel à ClickSend finit après.
         La page redirige vers /merci dans la foulée, elle n'attend pas. */
      ctx.waitUntil(envoie(env, tel, texte(prenom, ZONE.indexOf(dept) > -1)));
      return new Response(null, { status: 204 });
    }

    return env.ASSETS.fetch(request);
  }
};
