/**
 * ==========================================================================
 *  ROUTER.JS — Orchestrateur symbolique de l'Interface Mère
 * ==========================================================================
 *  Aucun LLM, aucune IA générative : uniquement des règles, des scores de
 *  correspondance, une mémoire locale d'associations apprises, et un
 *  principe strict — ne jamais prétendre qu'une capacité existe si elle
 *  n'existe pas.
 * ==========================================================================
 */

class Router {
  constructor({ registryUrl = "./registry.json", memoireCle = "orchestrateur-memoire", onLog = () => {} } = {}) {
    this.registryUrl = registryUrl;
    this.registry = null;
    this.onLog = onLog;
    this.journal = [];
    this.memoireCle = memoireCle;
    this.memoire = this._chargerMemoire();
  }

  // ========================================================================
  // Chargement du registre (source de vérité unique — point 9)
  // ========================================================================
  async chargerRegistre() {
    const t0 = performance.now();
    try {
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

  // ========================================================================
  // 1. FUZZY MATCHING — fautes de frappe, variantes, score de correspondance
  // ========================================================================

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
   * Radical très approximatif d'un mot français : retire les terminaisons
   * verbales/plurielles les plus courantes, uniquement pour rapprocher des
   * variantes d'un même mot ("calcule"/"calculer"/"calculons"). Ce n'est
   * pas un vrai lemmatiseur linguistique — juste une heuristique légère.
   */
  _radical(mot) {
    return mot.replace(/(ons|ez|ent|er|és|ée|ées|és|e|s)$/i, "").toLowerCase();
  }

  _motsProches(motMessage, motCle) {
    if (motMessage === motCle) return true;
    if (this._radical(motMessage) === this._radical(motCle) && this._radical(motCle).length >= 3) return true;
    if (Math.abs(motMessage.length - motCle.length) > 2) return false;
    const tolerance = motCle.length <= 4 ? 1 : motCle.length <= 8 ? 2 : 3;
    return this._distanceLevenshtein(motMessage, motCle) <= tolerance;
  }

  /**
   * Évalue TOUS les services du registre face à la requête (pas seulement
   * le meilleur) et renvoie une liste triée par score, chacun avec un
   * niveau de confiance honnête plutôt qu'un simple score brut.
   */
  evaluerCandidats(prompt) {
    if (!this.registry) throw new Error("Registre non chargé. Appeler chargerRegistre() d'abord.");

    const texteNormalise = prompt.toLowerCase();
    const motsMessage = texteNormalise.match(/[a-zàâçéèêëîïôûùüÿñæœ']+/g) || [];

    const candidats = this.registry.services.map((service) => {
      let score = 0;
      let matchExactTrouve = false;
      let matchApproxTrouve = false;

      for (const motCle of service.mots_cles) {
        const motCleNormalise = motCle.toLowerCase();
        if (texteNormalise.includes(motCleNormalise)) {
          score += 1;
          matchExactTrouve = true;
          continue;
        }
        if (!motCleNormalise.includes(" ") && motCleNormalise.length >= 3) {
          const approx = motsMessage.some((m) => this._motsProches(m, motCleNormalise));
          if (approx) { score += 0.5; matchApproxTrouve = true; }
        }
      }

      const confiance = matchExactTrouve ? "élevée" : matchApproxTrouve ? "moyenne" : "aucune";
      return { service, score, confiance };
    });

    return candidats.filter((c) => c.score > 0).sort((a, b) => b.score - a.score);
  }

  /**
   * Évalue les chaînes déclarées (registry.chaines) face à la requête,
   * avec le même principe de score que evaluerCandidats — mais uniquement
   * sur des mots-clés dédiés à la chaîne entière, pas déduit automatiquement.
   */
  evaluerChainesCandidates(prompt) {
    const texteNormalise = prompt.toLowerCase();
    return (this.registry.chaines || [])
      .map((chaine) => {
        let score = 0;
        for (const motCle of chaine.mots_cles || []) {
          if (texteNormalise.includes(motCle.toLowerCase())) score += 1;
        }
        return { chaine, score };
      })
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Exécute une chaîne déclarée étape par étape. Chaque étape utilise soit
   * le prompt original, soit un champ précis de la sortie de l'étape
   * précédente (mapping explicite, pas d'inférence). Termine proprement
   * et honnêtement si une étape échoue, plutôt que de prétendre un succès.
   */
  async executerChaine(chaine, promptOriginal) {
    let sortiePrecedente = null;
    const etapesReussies = [];

    for (const etape of chaine.etapes) {
      const service = this.registry.services.find((s) => s.id === etape.service);
      if (!service) {
        return {
          succes: true,
          texteRedige: `La chaîne "${chaine.nom}" référence un neurone introuvable (${etape.service}) — étape annulée.`
        };
      }

      let payload;
      if (etape.entree === "prompt_original" || !sortiePrecedente) {
        payload = this.construirePayload(service, promptOriginal);
      } else {
        const valeurEntree = (sortiePrecedente[etape.entree_depuis] || "").toString();
        payload = { [etape.champ_entree || "texte"]: valeurEntree };
      }

      const resultat = await this.appelerService(service, payload);

      if (resultat.succes === false) {
        return {
          succes: true,
          texteRedige:
            `La chaîne "${chaine.nom}" s'est arrêtée à l'étape "${service.nom}" (aucun résultat exploitable). ` +
            `Étape(s) réussie(s) avant cela : ${etapesReussies.join(", ") || "aucune"}.`
        };
      }

      etapesReussies.push(service.nom || service.id);
      sortiePrecedente = resultat;
    }

    // Vérification finale (§ principe essentiel : ne jamais prétendre un
    // succès sans texte exploitable réellement produit)
    const texteFinal = (sortiePrecedente && sortiePrecedente.texteRedige) || "";
    this._log("CHAINE_VERIFICATION", { chaine: chaine.id, valide: !!texteFinal.trim() });

    if (!texteFinal.trim()) {
      return { succes: true, texteRedige: `La chaîne "${chaine.nom}" s'est terminée sans produire de texte exploitable.` };
    }

    return {
      succes: true,
      texteRedige: texteFinal,
      resultats: sortiePrecedente.resultats || [],
      _chaine: chaine.id,
      _etapes: etapesReussies
    };
  }

  // ========================================================================
  // 2. ANALYSE STRUCTURÉE DE LA REQUÊTE
  // ========================================================================

  analyserRequete(prompt) {
    const texte = prompt.trim();
    const nombres = (texte.match(/-?\d+(?:[.,]\d+)?/g) || []).map((n) => parseFloat(n.replace(",", ".")));
    const guillemets = (texte.match(/"([^"]+)"|«([^»]+)»/g) || []);
    const motsSignificatifs = (texte.toLowerCase().match(/[a-zàâçéèêëîïôûùüÿñæœ']{3,}/g) || []);

    return {
      texteOriginal: texte,
      motsSignificatifs,
      parametresDetectes: { nombres, expressionsCitees: guillemets },
      longueur: texte.length
    };
  }

  // ========================================================================
  // 4. MÉMOIRE — associations apprises, jamais de modification du code
  // ========================================================================

  _chargerMemoire() {
    try {
      const brut = localStorage.getItem(this.memoireCle);
      return brut ? JSON.parse(brut) : {};
    } catch (erreur) {
      return {};
    }
  }

  _sauvegarderMemoire() {
    try {
      localStorage.setItem(this.memoireCle, JSON.stringify(this.memoire));
    } catch (erreur) {
      // Stockage indisponible (mode privé, quota...) : on continue sans mémoire persistante.
    }
  }

  _normaliserPourMemoire(texte) {
    return texte.trim().toLowerCase().replace(/\s+/g, " ");
  }

  rechercherMemoire(prompt) {
    const cle = this._normaliserPourMemoire(prompt);
    const entree = this.memoire[cle];
    if (!entree) return null;
    const service = this.registry.services.find((s) => s.id === entree.serviceId);
    if (!service) return null; // le neurone mémorisé a été retiré depuis
    return { service, occurrences: entree.occurrences };
  }

  enregistrerAssociation(prompt, serviceId) {
    const cle = this._normaliserPourMemoire(prompt);
    const existant = this.memoire[cle];
    this.memoire[cle] = {
      serviceId,
      occurrences: existant ? existant.occurrences + 1 : 1,
      derniereFois: new Date().toISOString()
    };
    this._sauvegarderMemoire();
  }

  /** Commande d'enseignement explicite : "mémorise : <phrase> = <id ou nom du service>" */
  traiterCommandeEnseignement(prompt) {
    const match = prompt.match(/^m[ée]morise\s*(?:que)?\s*:?\s*"?(.+?)"?\s*(?:doit utiliser|=|->|utilise)\s*(.+)$/i);
    if (!match) return null;

    const phrase = match[1].trim();
    const cibleTexte = match[2].trim().toLowerCase();
    const service = this.registry.services.find(
      (s) => s.id.toLowerCase() === cibleTexte || (s.nom || "").toLowerCase().includes(cibleTexte)
    );

    if (!service) {
      return {
        succes: true,
        interne: true,
        reponse: `<p>Je ne trouve aucun neurone correspondant à "${this._echapper(cibleTexte)}" dans le registre — rien n'a été mémorisé.</p>`
      };
    }

    this.enregistrerAssociation(phrase, service.id);
    return {
      succes: true,
      interne: true,
      reponse: `<p>Association mémorisée : la phrase "${this._echapper(phrase)}" utilisera désormais le neurone <strong>${this._echapper(service.nom || service.id)}</strong>.</p>`
    };
  }

  traiterCommandeOubli(prompt) {
    if (/^efface (la |ta )?m[ée]moire$/i.test(prompt.trim())) {
      this.memoire = {};
      this._sauvegarderMemoire();
      return { succes: true, interne: true, reponse: "<p>Toute la mémoire d'associations apprises a été effacée.</p>" };
    }
    const match = prompt.match(/^oublie\s*:?\s*"?(.+?)"?$/i);
    if (match) {
      const cle = this._normaliserPourMemoire(match[1]);
      if (this.memoire[cle]) {
        delete this.memoire[cle];
        this._sauvegarderMemoire();
        return { succes: true, interne: true, reponse: `<p>Association oubliée pour "${this._echapper(match[1].trim())}".</p>` };
      }
      return { succes: true, interne: true, reponse: `<p>Aucune association mémorisée ne correspond à "${this._echapper(match[1].trim())}".</p>` };
    }
    return null;
  }

  _echapper(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ========================================================================
  // 3. ORCHESTRATEUR — décision avec score de confiance (point 5),
  //    gestion de l'incertitude (point 6) et des capacités manquantes (point 7)
  // ========================================================================

  classifierRequete(prompt) {
    // Commandes d'enseignement/oubli traitées en priorité, avant toute classification
    const enseignement = this.traiterCommandeEnseignement(prompt);
    if (enseignement) return { type: "reponse_directe", reponse: enseignement };
    const oubli = this.traiterCommandeOubli(prompt);
    if (oubli) return { type: "reponse_directe", reponse: oubli };

    // 1) Mémoire d'associations déjà confirmées
    const souvenir = this.rechercherMemoire(prompt);
    if (souvenir) {
      this._log("CLASSIFICATION", {
        prompt, decision: "service", service: souvenir.service.id,
        confiance: "mémorisée", occurrences: souvenir.occurrences
      });
      return { type: "service", service: souvenir.service, confiance: "mémorisée" };
    }

    // 2) Chaînes déclarées vs. services simples — la chaîne l'emporte si
    // son score dédié est au moins aussi élevé qu'un service seul.
    const candidatsChaine = this.evaluerChainesCandidates(prompt);
    const candidats = this.evaluerCandidats(prompt);

    if (candidatsChaine.length > 0 && (candidats.length === 0 || candidatsChaine[0].score >= candidats[0].score)) {
      this._log("CLASSIFICATION", { prompt, decision: "chaine", chaine: candidatsChaine[0].chaine.id });
      return { type: "chaine", chaine: candidatsChaine[0].chaine };
    }

    if (candidats.length === 0) {
      const analyse = this.analyserRequete(prompt);
      this._log("CLASSIFICATION", { prompt, decision: "capacite_manquante", mots: analyse.motsSignificatifs });
      return { type: "capacite_manquante", motsDetectes: analyse.motsSignificatifs };
    }

    const meilleur = candidats[0];
    const deuxieme = candidats[1];

    // Ambiguïté : deux candidats à score très proche → incertitude assumée plutôt qu'un choix arbitraire
    if (deuxieme && meilleur.score - deuxieme.score < 0.5 && meilleur.confiance !== "élevée") {
      this._log("CLASSIFICATION", {
        prompt, decision: "incertain",
        candidats: [meilleur.service.id, deuxieme.service.id]
      });
      return { type: "incertain", candidats: [meilleur, deuxieme] };
    }

    this._log("CLASSIFICATION", { prompt, decision: "service", service: meilleur.service.id, confiance: meilleur.confiance });
    return { type: "service", service: meilleur.service, confiance: meilleur.confiance };
  }

  // ========================================================================
  // Construction du payload et appel du neurone (inchangé dans le principe)
  // ========================================================================

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
      default:
        return { texte: prompt, query: prompt };
    }
  }

  appelerService(service, payload) {
    return new Promise((resolve) => {
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

        this._log("APPEL_TERMINE", { service: service.id, requestId, duree_ms: duree, succes: !!data.result?.succes });

        const resultatBrut = data.result || {};
        let contenuUI = resultatBrut.reponse || "";

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

        if (!contenuUI) {
          const texteBrut = resultatBrut.texte || resultatBrut.expression || JSON.stringify(resultatBrut);
          contenuUI = `<p style="margin:0; color:#1A1A1A; line-height:1.5;">${texteBrut || "Réception des données effectuée avec succès."}</p>`;
        }

        resolve({ ...resultatBrut, reponse: contenuUI, _duree_ms: duree, _service: service.id });
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
        iframe.contentWindow.postMessage({ type: "MS_REQUEST", requestId, payload }, "*");
        this._log("APPEL_ENVOYE", { service: service.id, requestId, url: service.url, payload });
      };

      window.addEventListener("message", ecouteur);
      document.body.appendChild(iframe);
    });
  }

  // ========================================================================
  // Point d'entrée principal
  // ========================================================================

  async router(prompt, containerElement = null) {
    this._log("REQUETE_RECUE", { prompt });
    if (!this.registry) await this.chargerRegistre();

    const classification = this.classifierRequete(prompt);

    if (classification.type === "reponse_directe") {
      if (containerElement) containerElement.innerHTML = classification.reponse.reponse;
      return classification.reponse;
    }

    if (classification.type === "capacite_manquante") {
      const motsTexte = classification.motsDetectes.length > 0
        ? classification.motsDetectes.join(", ")
        : "(aucun mot significatif identifié)";
      const reponseInterne = {
        succes: true,
        interne: true,
        reponse:
          `<p><strong>Capacité manquante</strong> : aucun neurone du registre ne correspond, même approximativement, à cette demande.</p>` +
          `<p>Mots significatifs identifiés : ${this._echapper(motsTexte)}.</p>` +
          `<p>Ce diagnostic reste fondé sur des règles, pas sur une vraie compréhension — si un neurone existe déjà pour ce besoin, ` +
          `essayez de reformuler avec un mot plus proche de sa fonction déclarée. Sinon, un nouveau neurone devra être créé et enregistré ` +
          `dans le registre pour combler ce manque.</p>`
      };
      if (containerElement) containerElement.innerHTML = reponseInterne.reponse;
      return reponseInterne;
    }

    if (classification.type === "incertain") {
      const [a, b] = classification.candidats;
      const reponseIncertaine = {
        succes: true,
        interne: true,
        reponse:
          `<p><strong>Incertain</strong> : cette demande pourrait correspondre à plusieurs neurones sans qu'un seul se ` +
          `distingue clairement — <em>${this._echapper(a.service.nom || a.service.id)}</em> ou <em>${this._echapper(b.service.nom || b.service.id)}</em>.</p>` +
          `<p>Plutôt que de choisir au hasard, précisez votre demande pour lever l'ambiguïté.</p>`
      };
      if (containerElement) containerElement.innerHTML = reponseIncertaine.reponse;
      return reponseIncertaine;
    }

    if (classification.type === "chaine") {
      return await this.executerChaine(classification.chaine, prompt);
    }

    // type === "service"
    const service = classification.service;
    const payload = this.construirePayload(service, prompt);

    try {
      const resultat = await this.appelerService(service, payload);
      if (resultat && resultat.succes !== false) {
        this.enregistrerAssociation(prompt, service.id);
      }
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
      if (containerElement) containerElement.innerHTML = errRes.reponse;
      return errRes;
    }
  }

  _log(evenement, details) {
    const entree = { horodatage: new Date().toISOString(), evenement, details };
    this.journal.push(entree);
    this.onLog(entree);
  }

  getJournal() {
    return this.journal;
  }
}
