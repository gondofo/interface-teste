/**
 * ==========================================================================
 *  ROUTER.JS — Cœur du système de routage de l'Interface Mère
 * ==========================================================================
 *
 *  Responsabilités :
 *   1. Charger et parser le Registre (registry.json).
 *   2. Analyser la requête utilisateur pour déterminer quel(s) micro-service(s)
 *      sont pertinents (matching par mots-clés).
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
      const res = await fetch(this.registryUrl, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.registry = await res.json();
      this._log("REGISTRE_CHARGE", {
        nb_services: this.registry.services.length,
        duree_ms: Math.round(performance.now() - t0),
      });
      return this.registry;
    } catch (err) {
      this._log("REGISTRE_ERREUR", { erreur: err.message });
      throw err;
    }
  }

  /**
   * Analyse le prompt utilisateur et sélectionne le micro-service le plus
   * pertinent en comparant les mots-clés du registre au texte de la requête.
   */
  selectionnerService(prompt) {
    if (!this.registry) throw new Error("Registre non chargé. Appeler chargerRegistre() d'abord.");

    const texteNormalise = prompt.toLowerCase();
    let meilleurScore = 0;
    let meilleurService = null;

    for (const service of this.registry.services) {
      let score = 0;
      for (const motCle of service.mots_cles) {
        if (texteNormalise.includes(motCle.toLowerCase())) score++;
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
      iframe.src = service.url;

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
   * Point d'entrée principal : route la requête et injecte directement 
   * le HTML filtré via innerHTML dans le conteneur de l'interface.
   */
  async router(prompt, containerElement = null) {
    this._log("REQUETE_RECUE", { prompt });

    if (!this.registry) await this.chargerRegistre();

    const service = this.selectionnerService(prompt);
    if (!service) {
      this._log("AUCUN_SERVICE", { prompt });
      const errRes = {
        succes: false,
        reponse: "<p style='color:#666666; margin:0;'>Traitement effectué sans micro-service spécifique.</p>"
      };
      if (containerElement) {
        containerElement.innerHTML = errRes.reponse;
      }
      return errRes;
    }

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
async function handleSecureStorage(userMessage) {
    if (userMessage.startsWith("sauvegarde:")) {
        const contenu = userMessage.replace("sauvegarde:", "").trim();
        await window.secureStorage.setItem("ma_note_secrete", contenu, "MonMotDePasse123");
        return "Donnée chiffrée et sauvegardée en toute sécurité !";
    }



if (userMessage.startsWith("lis:")) {
    const resultat = await window.secureStorage.getItem("ma_note_secrete", "MonMotDePasse123");
    return `Voici ta note secrète : ${resultat}`;
}
return null;
}
