/**
 * ==========================================================================
 *  ROUTER.JS — Cœur du système de routage de l'Interface Mère
 *  (Avec intégration d'un LLM local embarqué via Transformers.js)
 * ==========================================================================
 */

class Router {
  constructor({ registryUrl = "./registry.json", onLog = () => {} } = {}) {
    this.registryUrl = registryUrl;
    this.registry = null;
    this.onLog = onLog;
    this.journal = [];
    this.localSummarizer = null; // Instance du LLM local
    this.isModelLoading = false;
  }

  /**
   * Charge et initialise un petit LLM local open-source pour le résumé (exécuté 100% dans le navigateur).
   */
  async initialiserLLMLocal() {
    if (this.localSummarizer || this.isModelLoading) return;
    this.isModelLoading = true;
    
    try {
      this._log("LLM_CHARGEMENT_DEBUT", { modele: "Xenova/distilbart-cnn-6-6" });
      
      // Import dynamique de Transformers.js depuis un CDN ESM officiel pour éviter l'installation de lourds paquets Node
      const { pipeline } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.0');
      
      // Téléchargement et mise en cache automatique du petit modèle local dans le navigateur
      this.localSummarizer = await pipeline('summarization', 'Xenova/distilbart-cnn-6-6');
      
      this._log("LLM_CHARGEMENT_SUCCES", { statut: "Prêt" });
    } catch (err) {
      this._log("LLM_CHARGEMENT_ERREUR", { erreur: err.message });
      console.warn("Impossible de charger le LLM local, bascule sur le mode assembleur.", err);
    } finally {
      this.isModelLoading = false;
    }
  }

  /**
   * Charge le registre centralisé depuis registry.json.
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
   * Analyse le prompt utilisateur et sélectionne le micro-service pertinent.
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
   * Construit la charge utile (payload).
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
   * Appelle un micro-service distant et passe le texte brut au LLM local pour rédaction.
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

      const ecouteur = async (event) => {
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
        let contenuUI = "";

        // 1. Extraction des snippets bruts de recherche
        let texteBrutAssemble = "";
        if (resultatBrut.reponse && typeof resultatBrut.reponse === 'string' && resultatBrut.reponse.trim().length > 0) {
          texteBrutAssemble = resultatBrut.reponse;
        } else if (resultatBrut.resultats && Array.isArray(resultatBrut.resultats) && resultatBrut.resultats.length > 0) {
          texteBrutAssemble = resultatBrut.resultats
            .map(r => (r.snippet || r.description || r.title || '').trim())
            .filter(text => text.length > 5)
            .join(" ");
        }

        // 2. Si on a du texte brut, on tente de le faire résumer par le LLM local embarqué
        if (texteBrutAssemble.length > 30) {
          try {
            // S'assure que le LLM est chargé (chargement transparent en arrière-plan si besoin)
            if (!this.localSummarizer && !this.isModelLoading) {
              await this.initialiserLLMLocal();
            }

            if (this.localSummarizer) {
              this._log("LLM_SYNTHESE_DEBUT", { taille_texte: texteBrutAssemble.length });
              
              // Génération locale par le modèle IA embarqué
              const resultatResume = await this.localSummarizer(texteBrutAssemble, {
                max_length: 130,
                min_length: 30,
                do_sample: false
              });

              if (resultatResume && resultatResume[0]?.summary_text) {
                const texteRedige = resultatResume[0].summary_text;
                contenuUI = `<p style="margin: 0; line-height: 1.6;">${texteRedige}</p>`;
                this._log("LLM_SYNTHESE_SUCCES", { resume: texteRedige });
              }
            }
          } catch (llmErr) {
            this._log("LLM_SYNTHESE_ERREUR", { erreur: llmErr.message });
          }
        }

        // 3. Fallback si le LLM n'est pas encore prêt ou a échoué : on utilise le texte brut nettoyé
        if (!contenuUI) {
          if (texteBrutAssemble) {
            contenuUI = `<p style="margin: 0; line-height: 1.6;">${texteBrutAssemble}</p>`;
          } else {
            contenuUI = `<p style="margin: 0; color: #d9534f;">Information insuffisante : aucun contenu exploitable trouvé.</p>`;
          }
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
        reject(new Error(`Timeout : le micro-service « ${service.id} » n'a pas répondu à temps.`));
      }, service.timeout_ms || 10000); // Délai un peu plus large pour laisser le LLM tourner la première fois

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
   * Point d'entrée principal : route la requête et injecte le résultat.
   */
  async router(prompt, containerElement = null) {
    this._log("REQUETE_RECUE", { prompt });

    if (!this.registry) await this.chargerRegistre();

    // Déclenche le chargement discret du LLM local dès la première interaction si souhaité
    this.initialiserLLMLocal();

    const service = this.selectionnerService(prompt);
    if (!service) {
      this._log("AUCUN_SERVICE", { prompt });
      const errRes = {
        succes: false,
        erreur: "Aucun micro-service du registre ne correspond à cette requête.",
        reponse: "<p style='color:#666666;'>Aucun micro-service ne correspond à cette requête.</p>"
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
        erreur: err.message, 
        reponse: `<p style='color:#d9534f; margin:0;'>Erreur : ${err.message}</p>`,
        _service: service.id 
      };
      if (containerElement) {
        containerElement.innerHTML = errRes.reponse;
      }
      return errRes;
    }
  }

  _log(evenement, details) {
    const entree = {
      horodatage: new Date().toISOString(),
      evenement,
      details,
    };
    this.journal.push(entree);
    this.onLog(entree);
  }

  getJournal() {
    return this.journal;
  }
}
