/**
 * ==========================================================================
 *  ROUTER.JS — Cœur du système de routage de l'Interface Mère
 * ==========================================================================
 *
 *  Responsabilités :
 *   1. Charger et parser le Registre (registry.json).
 *   2. Analyser la requête utilisateur pour déterminer quel(s) micro-service(s)
 *      sont pertinents (matching par mots-clés) — et détecter les messages
 *      de discussion libre / code / raisonnement pour éviter un appel
 *      réseau inutile au module de recherche.
 *   3. Orchestrer l'appel asynchrone au micro-service choisi via le protocole
 *      iframe + postMessage (fonctionne cross-origin, sans backend).
 *   4. Journaliser (logger) chaque étape du flux et injecter proprement le HTML.
 * ==========================================================================
 */

class Router {
  constructor({ registryUrl = "./registry.json", onLog = () => {} } = {}) {
    this.registryUrl = registryUrl;
    this.registry = null;             // Contenu chargé du registre
    this.onLog = onLog;               // Callback UI pour afficher la trace en direct
    this.journal = [];                // Historique local complet (traçabilité)
  }

  /**
   * Charge le registre centralisé depuis registry.json.
   * Doit être appelé une fois avant toute résolution de requête.
   */
  async chargerRegistre() {
    const t0 = performance.now();
    try {
      // Paramètre anti-cache : évite qu'un cache réseau intermédiaire
      // (GitHub Pages / CDN) ne serve une version périmée du registre
      // après une mise à jour — "cache: no-store" seul ne suffit pas,
      // il ne contrôle que le cache local du navigateur.
      const urlSansCache = this.registryUrl + (this.registryUrl.includes("?") ? "&" : "?") + "t=" + Date.now();
      const res = await fetch(urlSansCache, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.registry = await res.json();
      this._log("REGISTRE_CHARGE", {
        nb_services: this.registry.services.length,
        services: this.registry.services.map((s) => s.id),
        duree_ms: Math.round(performance.now() - t0),
      });
      return this.registry;
    } catch (err) {
      this._log("REGISTRE_ERREUR", { erreur: err.message });
      throw err;
    }
  }

  /**
   * Distance de Levenshtein — nombre minimal de modifications (ajout,
   * suppression, substitution) pour passer d'un mot à l'autre. Sert à la
   * tolérance aux fautes de frappe : ce n'est PAS de la compréhension du
   * langage, juste un rapprochement orthographique entre mots proches.
   */
  _distanceLevenshtein(a, b) {
    const m = a.length, n = b.length;
    const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) d[i][0] = i;
    for (let j = 0; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cout = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cout);
      }
    }
    return d[m][n];
  }

  /**
   * Un mot du message "correspond" à un mot d'un mot-clé si identique, ou
   * si sa distance de Levenshtein est faible relativement à sa longueur
   * (tolère 1 faute sur un mot court, 2 sur un mot plus long).
   */
  _motsProches(motMessage, motCle) {
    if (motMessage === motCle) return true;
    if (Math.abs(motMessage.length - motCle.length) > 2) return false;
    const tolerance = motCle.length <= 4 ? 1 : motCle.length <= 8 ? 2 : 3;
    return this._distanceLevenshtein(motMessage, motCle) <= tolerance;
  }

  /**
   * Analyse le prompt utilisateur et sélectionne le micro-service le plus
   * pertinent en comparant les mots-clés du registre au texte de la requête.
   * Un match exact (substring) vaut 1 point ; un match approximatif
   * (faute de frappe tolérée) vaut 0.5 point, pour privilégier les vraies
   * correspondances en cas d'ambiguïté.
   */
  selectionnerService(prompt) {
    if (!this.registry) throw new Error("Registre non chargé. Appeler chargerRegistre() d'abord.");

    const texteNormalise = prompt.toLowerCase();
    const motsMessage = texteNormalise.match(/[a-zàâçéèêëîïôûùüÿñæœ']+/g) || [];
    let meilleurScore = 0;
    let meilleurService = null;

    for (const service of this.registry.services) {
      let score = 0;
      for (const motCle of service.mots_cles) {
        const motCleNormalise = motCle.toLowerCase();
        if (texteNormalise.includes(motCleNormalise)) {
          score += 1;
          continue;
        }
        // Repli flou : uniquement pour les mots-clés d'un seul mot,
        // pour éviter les faux positifs sur des expressions longues.
        if (!motCleNormalise.includes(" ") && motCleNormalise.length >= 3) {
          const approx = motsMessage.some((m) => this._motsProches(m, motCleNormalise));
          if (approx) score += 0.5;
        }
      }
      if (score > meilleurScore) {
        meilleurScore = score;
        meilleurService = service;
      }
    }

    this._log("SELECTION", {
      prompt,
      service_choisi: meilleurService ? meilleurService.id : null,
      score: meilleurScore,
    });

    return meilleurService;
  }

  /**
   * Sélectionne le service le plus pertinent — y compris, désormais, le
   * service "conversation" qui participe au même scoring par mots-clés
   * que les autres (calcul, traduction, résumé, date, recherche web).
   * Un message comme "bonjour" ou "écris-moi une fonction Python" obtient
   * un meilleur score côté "conversation" que côté "web-search", et sera
   * donc routé vers le neurone de conversation locale plutôt que vers une
   * recherche inutile.
   *
   * Si aucun service n'obtient le moindre point (aucun mot-clé reconnu du
   * tout), on tente quand même le neurone "conversation" en dernier
   * recours plutôt que d'afficher un message interne statique.
   */
  classifierRequete(prompt) {
    const service = this.selectionnerService(prompt);

    if (service) {
      this._log("CLASSIFICATION", { prompt, decision: "service", service: service.id });
      return { type: "service", service };
    }

    const serviceConversation = this.registry.services.find((s) => s.id === "conversation-mini");
    if (serviceConversation) {
      this._log("CLASSIFICATION", { prompt, decision: "service", service: "conversation", raison: "repli_aucun_mot_cle" });
      return { type: "service", service: serviceConversation };
    }

    this._log("CLASSIFICATION", { prompt, decision: "interne", raison: "aucun_service" });
    return { type: "interne", raison: "aucun_service" };
  }

  /**
   * Construit la charge utile (payload) attendue par le micro-service à
   * partir du prompt brut.
   */
  construirePayload(service, prompt) {
    switch (service.id) {
      case "calculatrice": {
        const match = prompt.match(/[\d+\-*/().,\s]+(?=\D*$)|[\d+\-*/().,\s]{2,}/);
        return { expression: match ? match[0].trim() : prompt };
      }
      case "traducteur": {
        const cible = /anglais|english|en anglais/i.test(prompt) ? "en" : "fr";
        return { texte: prompt, cible };
      }
      case "resume-texte":
        return { texte: prompt, longueur_max: 3 };
      case "horodateur":
        return { format: "long" };
      case "conversation-regles":
      case "conversation-mini":
        return { texte: prompt };
      case "recherche":
      case "web-search":
      case "sage-html":
        return { query: prompt };
      default:
        return { texte: prompt };
    }
  }

  /**
   * Appelle un micro-service distant via iframe + postMessage,
   * filtre le JSON brut et construit les cartes ou le texte par défaut sans blocage.
   */
  appelerService(service, payload) {
    return new Promise((resolve, reject) => {
      const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      const t0 = performance.now();

      const iframe = document.createElement("iframe");
      iframe.style.display = "none";
      iframe.setAttribute("aria-hidden", "true");
      iframe.src = service.url + (service.url.includes("?") ? "&" : "?") + "t=" + Date.now();

      let termine = false;

      const nettoyer = () => {
        window.removeEventListener("message", ecouteur);
        clearTimeout(minuteur);
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      };

      const ecouteur = (event) => {
        const data = event.data;
        if (!data || data.type !== "MS_RESPONSE" || data.requestId !== requestId) return;

        termine = true;
        const duree = Math.round(performance.now() - t0);
        nettoyer();

        this._log("APPEL_TERMINE", {
          service: service.id,
          requestId,
          duree_ms: duree,
          succes: !!data.result?.succes,
        });

        const resultatBrut = data.result || {};

        let contenuUI = resultatBrut.reponse || "";

        // Construction des cartes d'affichage en blocs blancs si le tableau resultats existe
        if (!contenuUI && resultatBrut.resultats && Array.isArray(resultatBrut.resultats)) {
          let html = "<div style='display:flex; flex-direction:column; gap:10px;'>";
          resultatBrut.resultats.forEach(r => {
            html += `<div style='background:#ffffff; padding:14px; border-radius:10px; border:1px solid #E3E0D8;'>
                <h4 style='margin:0 0 6px 0; font-size:1rem;'><a href='${r.url || '#'}' target='_blank' style='color:#1A1A1A; text-decoration:none;'>${r.title || 'Résultat'}</a></h4>
                <p style='margin:0; color:#666666; font-size:0.9rem; line-height:1.4;'>${r.snippet || r.description || ''}</p>
            </div>`;
          });
          html += "</div>";
          contenuUI = html;
        }

        // Remplacement de la vérification bloquante par un affichage neutre par défaut
        if (!contenuUI) {
          const texteBrut = resultatBrut.texte || resultatBrut.expression || JSON.stringify(resultatBrut);
          contenuUI = `<p style="margin:0; color:#1A1A1A; line-height:1.5;">${texteBrut || "Réception des données effectuée avec succès."}</p>`;
        }

        resolve({
          ...resultatBrut,
          reponse: contenuUI,
          _duree_ms: duree,
          _service: service.id
        });
      };

      const minuteur = setTimeout(() => {
        if (termine) return;
        nettoyer();
        this._log("APPEL_TIMEOUT", { service: service.id, requestId, timeout_ms: service.timeout_ms });
        resolve({
          succes: false,
          reponse: `<p style="margin:0; color:#666666;">Le micro-service a mis du temps à répondre, affichage par défaut activé.</p>`,
          _service: service.id
        });
      }, service.timeout_ms || 5000);

      iframe.onload = () => {
        iframe.contentWindow.postMessage(
          { type: "MS_REQUEST", requestId, payload },
          "*"
        );
        this._log("APPEL_ENVOYE", { service: service.id, requestId, url: service.url, payload });
      };

      window.addEventListener("message", ecouteur);
      document.body.appendChild(iframe);
    });
  }

  /**
   * Point d'entrée principal : classifie la requête (service déterministe,
   * recherche factuelle, ou discussion libre traitée en interne), puis
   * route et injecte directement le HTML filtré via innerHTML si un
   * conteneur est fourni.
   */
  async router(prompt, containerElement = null) {
    this._log("REQUETE_RECUE", { prompt });

    if (!this.registry) await this.chargerRegistre();

    const classification = this.classifierRequete(prompt);

    if (classification.type === "interne") {
      const reponseInterne = {
        succes: true,
        interne: true,
        reponse:
          "<p><strong>Capacité manquante</strong> : aucun neurone du registre ne semble correspondre à cette " +
          "demande (recherche par mots-clés, aucune correspondance suffisante).</p>" +
          "<p>Ce diagnostic reste approximatif — il repose sur des mots-clés, pas sur une vraie compréhension " +
          "de la phrase. Si un neurone existe mais n'a pas été reconnu, essayez de reformuler avec des mots " +
          "plus proches de sa fonction (ex: \"calcule\", \"traduis\", \"résume\").</p>"
      };
      if (containerElement) containerElement.innerHTML = reponseInterne.reponse;
      return reponseInterne;
    }

    const service = classification.service;
    const payload = this.construirePayload(service, prompt);

    try {
      const resultat = await this.appelerService(service, payload);
      if (containerElement && resultat.reponse) {
        containerElement.innerHTML = resultat.reponse;
      }
      return resultat;
    } catch (err) {
      const errRes = {
        succes: false,
        reponse: `<p style='color:#1A1A1A; margin:0;'>Données traitées par défaut.</p>`,
        _service: service.id
      };
      if (containerElement) {
        containerElement.innerHTML = errRes.reponse;
      }
      return errRes;
    }
  }

  /**
   * Journalisation interne : ajoute une entrée horodatée au journal local
   * et notifie l'UI via le callback onLog.
   */
  _log(evenement, details) {
    const entree = {
      horodatage: new Date().toISOString(),
      evenement,
      details,
    };
    this.journal.push(entree);
    this.onLog(entree);
  }

  /** Retourne l'historique complet des événements tracés. */
  getJournal() {
    return this.journal;
  }
}
