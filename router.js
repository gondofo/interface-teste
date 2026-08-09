/**
 * ==========================================================================
 * ROUTER.JS — Cœur du système de routage de l'Interface Mère
 * ==========================================================================
 *
 * Responsabilités :
 *   1. Charger et parser le Registre (registry.json).
 *   2. Analyser la requête utilisateur afin de déterminer quel micro-service
 *      est pertinent grâce aux mots-clés.
 *   3. Orchestrer l'appel asynchrone au micro-service via iframe + postMessage.
 *   4. Journaliser les différentes étapes du flux.
 *   5. Injecter proprement le résultat dans l'interface.
 *
 * Stockage sécurisé :
 *   - Le mot de passe n'est jamais écrit en dur dans le code.
 *   - Il est fourni dynamiquement pendant la session avec :
 *
 *       mdp:VotreMotDePasse
 *
 *   - Puis :
 *
 *       sauvegarde:Votre note
 *
 *       lis:
 *
 * ==========================================================================
 */


/* ==========================================================================
 * ROUTER
 * ========================================================================== */

class Router {
  constructor({
    registryUrl = "./registry.json",
    onLog = () => {}
  } = {}) {
    this.registryUrl = registryUrl;
    this.registry = null;
    this.onLog = onLog;
    this.journal = [];
  }


  /**
   * ------------------------------------------------------------------------
   * Charge le registre centralisé depuis registry.json.
   * ------------------------------------------------------------------------
   */
  async chargerRegistre() {
    const t0 = performance.now();

    try {
      const res = await fetch(this.registryUrl, {
        cache: "no-store"
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      this.registry = await res.json();

      if (
        !this.registry ||
        !Array.isArray(this.registry.services)
      ) {
        throw new Error(
          "Format invalide : registry.json doit contenir un tableau 'services'."
        );
      }

      this._log("REGISTRE_CHARGE", {
        nb_services: this.registry.services.length,
        duree_ms: Math.round(performance.now() - t0)
      });

      return this.registry;

    } catch (err) {
      this._log("REGISTRE_ERREUR", {
        erreur: err.message
      });

      throw err;
    }
  }


  /**
   * ------------------------------------------------------------------------
   * Sélectionne le micro-service le plus pertinent.
   * ------------------------------------------------------------------------
   */
  selectionnerService(prompt) {
    if (!this.registry) {
      throw new Error(
        "Registre non chargé. Appeler chargerRegistre() d'abord."
      );
    }

    const texteNormalise = String(prompt || "").toLowerCase();

    let meilleurScore = 0;
    let meilleurService = null;

    for (const service of this.registry.services) {
      if (!service || !Array.isArray(service.mots_cles)) {
        continue;
      }

      let score = 0;

      for (const motCle of service.mots_cles) {
        if (
          typeof motCle === "string" &&
          texteNormalise.includes(motCle.toLowerCase())
        ) {
          score++;
        }
      }

      if (score > meilleurScore) {
        meilleurScore = score;
        meilleurService = service;
      }
    }

    this._log("SELECTION", {
      prompt,
      service_choisi: meilleurService
        ? meilleurService.id
        : null,
      score: meilleurScore
    });

    return meilleurService;
  }


  /**
   * ------------------------------------------------------------------------
   * Construit le payload envoyé au micro-service.
   * ------------------------------------------------------------------------
   */
  construirePayload(service, prompt) {
    if (!service || !service.id) {
      return {
        texte: prompt
      };
    }

    switch (service.id) {

      case "calculatrice": {
        const match = String(prompt).match(
          /[\d+\-*/().,\s]+(?=\D*$)|[\d+\-*/().,\s]{2,}/
        );

        return {
          expression: match
            ? match[0].trim()
            : prompt
        };
      }


      case "traducteur": {
        const cible =
          /anglais|english|en anglais/i.test(prompt)
            ? "en"
            : "fr";

        return {
          texte: prompt,
          cible
        };
      }


      case "resume-texte":
        return {
          texte: prompt,
          longueur_max: 3
        };


      case "horodateur":
        return {
          format: "long"
        };


      case "recherche":
      case "web-search":
      case "sage-html":
        return {
          query: prompt
        };


      default:
        return {
          texte: prompt
        };
    }
  }


  /**
   * ------------------------------------------------------------------------
   * Échappe les caractères HTML afin d'éviter d'injecter directement
   * des données externes dans innerHTML.
   * ------------------------------------------------------------------------
   */
  _echapperHTML(valeur) {
    const texte = String(valeur ?? "");

    return texte
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }


  /**
   * ------------------------------------------------------------------------
   * Appelle un micro-service distant via iframe + postMessage.
   * ------------------------------------------------------------------------
   */
  appelerService(service, payload) {
    return new Promise((resolve) => {

      const requestId =
        `req_${Date.now()}_${Math.random()
          .toString(36)
          .slice(2, 9)}`;

      const t0 = performance.now();

      const iframe = document.createElement("iframe");

      iframe.style.display = "none";
      iframe.setAttribute("aria-hidden", "true");
      iframe.src = service.url;

      let termine = false;
      let minuteur = null;


      /**
       * Nettoyage de l'iframe et du listener.
       */
      const nettoyer = () => {
        window.removeEventListener(
          "message",
          ecouteur
        );

        if (minuteur) {
          clearTimeout(minuteur);
        }

        if (iframe.parentNode) {
          iframe.parentNode.removeChild(iframe);
        }
      };


      /**
       * Réception du message du micro-service.
       */
      const ecouteur = (event) => {

        const data = event.data;

        if (
          !data ||
          data.type !== "MS_RESPONSE" ||
          data.requestId !== requestId
        ) {
          return;
        }

        termine = true;

        const duree = Math.round(
          performance.now() - t0
        );

        nettoyer();

        const resultatBrut =
          data.result &&
          typeof data.result === "object"
            ? data.result
            : {};


        this._log("APPEL_TERMINE", {
          service: service.id,
          requestId,
          duree_ms: duree,
          succes: !!resultatBrut.succes
        });


        let contenuUI =
          typeof resultatBrut.reponse === "string"
            ? resultatBrut.reponse
            : "";


        /**
         * Construction des cartes de résultats.
         */
        if (
          !contenuUI &&
          Array.isArray(resultatBrut.resultats)
        ) {

          let html =
            "<div style=\"display:flex;flex-direction:column;gap:10px;\">";


          resultatBrut.resultats.forEach((r) => {

            if (!r || typeof r !== "object") {
              return;
            }

            const titre =
              this._echapperHTML(
                r.title || "Résultat"
              );

            const description =
              this._echapperHTML(
                r.snippet ||
                r.description ||
                ""
              );

            const url =
              typeof r.url === "string" &&
              /^https?:\/\//i.test(r.url)
                ? this._echapperHTML(r.url)
                : "#";


            html += `
              <div
                style="
                  background:#ffffff;
                  padding:14px;
                  border-radius:10px;
                  border:1px solid #E3E0D8;
                "
              >
                <h4
                  style="
                    margin:0 0 6px 0;
                    font-size:1rem;
                  "
                >
                  <a
                    href="${url}"
                    target="_blank"
                    rel="noopener noreferrer"
                    style="
                      color:#1A1A1A;
                      text-decoration:none;
                    "
                  >
                    ${titre}
                  </a>
                </h4>

                <p
                  style="
                    margin:0;
                    color:#666666;
                    font-size:0.9rem;
                    line-height:1.4;
                  "
                >
                  ${description}
                </p>
              </div>
            `;
          });


          html += "</div>";

          contenuUI = html;
        }


        /**
         * Affichage de secours.
         */
        if (!contenuUI) {

          const texteBrut =
            resultatBrut.texte ??
            resultatBrut.expression ??
            "";

          const texteSecurise =
            this._echapperHTML(texteBrut);


          contenuUI = `
            <p
              style="
                margin:0;
                color:#1A1A1A;
                line-height:1.5;
              "
            >
              ${
                texteSecurise ||
                "Réception des données effectuée avec succès."
              }
            </p>
          `;
        }


        resolve({
          ...resultatBrut,

          reponse: contenuUI,

          _duree_ms: duree,

          _service: service.id
        });
      };


      /**
       * Timeout du micro-service.
       */
      minuteur = setTimeout(() => {

        if (termine) {
          return;
        }

        termine = true;

        nettoyer();

        this._log("APPEL_TIMEOUT", {
          service: service.id,
          requestId,
          timeout_ms: service.timeout_ms || 5000
        });


        resolve({
          succes: false,

          reponse: `
            <p
              style="
                margin:0;
                color:#666666;
              "
            >
              Le micro-service a mis du temps à répondre.
              Affichage par défaut activé.
            </p>
          `,

          _service: service.id
        });

      }, service.timeout_ms || 5000);


      /**
       * Une fois l'iframe chargée, envoie la requête.
       */
      iframe.onload = () => {

        try {

          if (!iframe.contentWindow) {
            throw new Error(
              "Impossible d'accéder à la fenêtre du micro-service."
            );
          }


          iframe.contentWindow.postMessage(
            {
              type: "MS_REQUEST",
              requestId,
              payload
            },
            "*"
          );


          this._log("APPEL_ENVOYE", {
            service: service.id,
            requestId,
            url: service.url,

            // Le payload peut contenir des données utilisateur,
            // mais jamais le mot de passe du stockage sécurisé.
            payload
          });

        } catch (err) {

          if (termine) {
            return;
          }

          termine = true;

          nettoyer();

          this._log("APPEL_ERREUR", {
            service: service.id,
            requestId,
            erreur: err.message
          });


          resolve({
            succes: false,

            reponse: `
              <p
                style="
                  margin:0;
                  color:#666666;
                "
              >
                Impossible de communiquer avec le micro-service.
              </p>
            `,

            _service: service.id
          });
        }
      };


      iframe.onerror = () => {

        if (termine) {
          return;
        }

        termine = true;

        nettoyer();

        this._log("IFRAME_ERREUR", {
          service: service.id,
          requestId
        });


        resolve({
          succes: false,

          reponse: `
            <p
              style="
                margin:0;
                color:#666666;
              "
            >
              Le micro-service n'a pas pu être chargé.
            </p>
          `,

          _service: service.id
        });
      };


      window.addEventListener(
        "message",
        ecouteur
      );


      document.body.appendChild(iframe);
    });
  }


  /**
   * ------------------------------------------------------------------------
   * Point d'entrée principal.
   * ------------------------------------------------------------------------
   */
  async router(
    prompt,
    containerElement = null
  ) {

    this._log("REQUETE_RECUE", {
      prompt
    });


    if (!this.registry) {
      await this.chargerRegistre();
    }


    const service =
      this.selectionnerService(prompt);


    /**
     * Aucun service trouvé.
     */
    if (!service) {

      this._log("AUCUN_SERVICE", {
        prompt
      });


      const errRes = {
        succes: false,

        reponse: `
          <p
            style="
              color:#666666;
              margin:0;
            "
          >
            Traitement effectué sans micro-service spécifique.
          </p>
        `
      };


      if (containerElement) {
        containerElement.innerHTML =
          errRes.reponse;
      }


      return errRes;
    }


    const payload =
      this.construirePayload(
        service,
        prompt
      );


    try {

      const resultat =
        await this.appelerService(
          service,
          payload
        );


      if (
        containerElement &&
        resultat.reponse
      ) {
        containerElement.innerHTML =
          resultat.reponse;
      }


      return resultat;

    } catch (err) {

      this._log("ROUTAGE_ERREUR", {
        service: service.id,
        erreur: err.message
      });


      const errRes = {

        succes: false,

        reponse: `
          <p
            style="
              color:#1A1A1A;
              margin:0;
            "
          >
            Données traitées par défaut.
          </p>
        `,

        _service: service.id
      };


      if (containerElement) {
        containerElement.innerHTML =
          errRes.reponse;
      }


      return errRes;
    }
  }


  /**
   * ------------------------------------------------------------------------
   * Journalisation interne.
   * ------------------------------------------------------------------------
   */
  _log(
    evenement,
    details = {}
  ) {

    const entree = {

      horodatage:
        new Date().toISOString(),

      evenement,

      details
    };


    this.journal.push(entree);


    try {
      this.onLog(entree);
    } catch (err) {
      console.warn(
        "Erreur dans onLog :",
        err
      );
    }
  }


  /**
   * ------------------------------------------------------------------------
   * Retourne l'historique complet.
   * ------------------------------------------------------------------------
   */
  getJournal() {
    return [...this.journal];
  }
}


/* ==========================================================================
 * STOCKAGE SÉCURISÉ
 * ========================================================================== */

/**
 * Mot de passe actuellement utilisé pendant la session.
 *
 * IMPORTANT :
 * - Aucun mot de passe n'est écrit ici.
 * - La valeur est fournie dynamiquement par l'utilisateur.
 * - Cette variable existe uniquement en mémoire JavaScript pendant la session.
 */
let motDePasseSession = null;


/**
 * --------------------------------------------------------------------------
 * Définit le mot de passe de session.
 *
 * Commande utilisateur :
 *
 *     mdp:MonMotDePasse
 *
 * --------------------------------------------------------------------------
 */
function definirMotDePasseSession(motDePasse) {

  if (
    typeof motDePasse !== "string" ||
    motDePasse.trim() === ""
  ) {
    return {
      succes: false,
      reponse: "Le mot de passe ne peut pas être vide."
    };
  }


  motDePasseSession =
    motDePasse;


  return {
    succes: true,
    reponse:
      "Mot de passe de session défini."
  };
}


/**
 * --------------------------------------------------------------------------
 * Efface le mot de passe actuellement présent en mémoire.
 * --------------------------------------------------------------------------
 */
function effacerMotDePasseSession() {

  motDePasseSession = null;


  return {
    succes: true,
    reponse:
      "Mot de passe de session effacé."
  };
}


/**
 * --------------------------------------------------------------------------
 * Gestion du stockage sécurisé.
 *
 * Commandes supportées :
 *
 *     mdp:MON_MOT_DE_PASSE
 *
 *     sauvegarde:Ma note secrète
 *
 *     lis:
 *
 * --------------------------------------------------------------------------
 */
async function handleSecureStorage(
  userMessage
) {

  if (
    typeof userMessage !== "string"
  ) {
    return {
      succes: false,
      reponse:
        "Commande invalide."
    };
  }


  const message =
    userMessage.trim();


  /**
   * ------------------------------------------------------------------------
   * Définition dynamique du mot de passe.
   * ------------------------------------------------------------------------
   */
  if (
    message.toLowerCase()
      .startsWith("mdp:")
  ) {

    const motDePasse =
      message
        .slice(4)
        .trim();


    return definirMotDePasseSession(
      motDePasse
    );
  }


  /**
   * ------------------------------------------------------------------------
   * Effacement du mot de passe.
   *
   * Commande :
   *
   *     mdp:clear
   *
   * ------------------------------------------------------------------------
   */
  if (
    message.toLowerCase() ===
    "mdp:clear"
  ) {

    return effacerMotDePasseSession();
  }


  /**
   * ------------------------------------------------------------------------
   * Vérification du mot de passe.
   * ------------------------------------------------------------------------
   */
  if (!motDePasseSession) {

    return {
      succes: false,

      reponse:
        "Aucun mot de passe de session n'a été défini. Utilise d'abord la commande mdp:."
    };
  }


  /**
   * ------------------------------------------------------------------------
   * Sauvegarde.
   *
   * Exemple :
   *
   *     sauvegarde:Ma note secrète
   * ------------------------------------------------------------------------
   */
  if (
    message.toLowerCase()
      .startsWith("sauvegarde:")
  ) {

    const contenu =
      message
        .slice(
          "sauvegarde:".length
        )
        .trim();


    if (!contenu) {

      return {
        succes: false,

        reponse:
          "Aucune donnée à sauvegarder."
      };
    }


    try {

      if (
        !window.secureStorage ||
        typeof window.secureStorage.setItem !==
          "function"
      ) {

        throw new Error(
          "Le module secureStorage n'est pas disponible."
        );
      }


      await window.secureStorage.setItem(
        "ma_note_secrete",
        contenu,
        motDePasseSession
      );


      return {
        succes: true,

        reponse:
          "Donnée chiffrée et sauvegardée avec succès."
      };

    } catch (err) {

      console.error(
        "Erreur secureStorage.setItem :",
        err
      );


      return {
        succes: false,

        reponse:
          "Impossible de sauvegarder la donnée."
      };
    }
  }


  /**
   * ------------------------------------------------------------------------
   * Lecture.
   *
   * Commande :
   *
   *     lis:
   * ------------------------------------------------------------------------
   */
  if (
    message.toLowerCase() ===
    "lis:"
  ) {

    try {

      if (
        !window.secureStorage ||
        typeof window.secureStorage.getItem !==
          "function"
      ) {

        throw new Error(
          "Le module secureStorage n'est pas disponible."
        );
      }


      const resultat =
        await window.secureStorage.getItem(
          "ma_note_secrete",
          motDePasseSession
        );


      if (
        resultat === null ||
        typeof resultat === "undefined"
      ) {

        return {
          succes: false,

          reponse:
            "Aucune note sauvegardée trouvée."
        };
      }


      return {
        succes: true,

        reponse:
          "Voici ta note secrète : " +
          String(resultat)
      };

    } catch (err) {

      console.error(
        "Erreur secureStorage.getItem :",
        err
      );


      return {
        succes: false,

        reponse:
          "Impossible de lire la donnée sécurisée."
      };
    }
  }


  /**
   * ------------------------------------------------------------------------
   * Commande inconnue.
   * ------------------------------------------------------------------------
   */
  return {
    succes: false,

    reponse:
      "Commande de stockage non reconnue."
  };
}


/* ==========================================================================
 * EXPOSITION GLOBALE
 * ========================================================================== */

/**
 * Le routeur peut être utilisé directement depuis l'application.
 *
 * Exemple :
 *
 *     const router = new Router();
 *
 *     router.router(
 *       "Calcule 25 + 17",
 *       document.getElementById("resultat")
 *     );
 *
 */


/**
 * Expose handleSecureStorage afin que l'interface principale puisse
 * transmettre les commandes utilisateur.
 */
window.handleSecureStorage =
  handleSecureStorage;


/**
 * Expose les fonctions de gestion du mot de passe si l'interface
 * doit permettre de réinitialiser la session.
 */
window.definirMotDePasseSession =
  definirMotDePasseSession;

window.effacerMotDePasseSession =
  effacerMotDePasseSession;


/**
 * Expose Router.
 */
window.Router = Router;
