# Mon Bilan Soleil, landing page

Landing page Google Ads pour Mon Bilan Soleil (service d'EKO HABITATIONS), avec questionnaire en hero.

## Fichiers
- `index.html` : page complète (CSS et JS intégrés)
- `mentions-legales.html`, `confidentialite.html`
- `img/` : logo vectorisé, photos optimisées en WebP, favicon

## Formulaire
- Endpoint : attribut `data-endpoint` du `<form id="q-form">`. Tant qu'il contient `REMPLACER`, l'envoi est simulé (payload visible dans la console).
- Payload JSON envoyé en POST : statut, facture_mensuelle, delai_projet, priorite (chaud / tiède / froid), code_postal, commune, departement, prenom, nom, email, telephone, telephone_e164, consentement_contact, consentement_texte, consentement_horodatage, date_envoi, page_url, referrer, user_agent, gclid, gbraid, wbraid, fbclid, utm_*.
- Événements dataLayer : `quiz_start`, `quiz_step`, `generate_lead` (avec `user_data` pour les conversions améliorées), `cta_click`.
- GTM : snippet commenté dans le `<head>` et en haut du `<body>` (remplacer GTM-XXXXXXX).

## À compléter avant mise en ligne
- Exemple représentatif du crédit (pied de page)
- Numéro RGE, ORIAS, médiateur, décennale (mentions légales)
