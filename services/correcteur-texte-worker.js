/**
 * ==========================================================================
 *  CORRECTEUR-TEXTE-WORKER.JS — Pipeline de traitement textuel déterministe
 * ==========================================================================
 *  Aucun LLM, aucun apprentissage statistique. RegEx + automate simple pour
 *  la segmentation + heuristiques de structuration + nspell (vrai
 *  dictionnaire Hunspell français) pour l'orthographe — mis en cache dans
 *  IndexedDB après le premier téléchargement.
 * ==========================================================================
 */
import nspell from "https://esm.sh/nspell@2";

// ----------------------------------------------------------------------
// Cache IndexedDB minimal pour le dictionnaire (téléchargé une seule fois)
// ----------------------------------------------------------------------
function ouvrirCache() {
  return new Promise((resolve, reject) => {
    const requete = indexedDB.open("dictionnaire-fr-cache", 1);
    requete.onupgradeneeded = () => requete.result.createObjectStore("cache");
    requete.onsuccess = () => {
      const db = requete.result;
      resolve({
        get: (cle) => new Promise((res) => {
          const tx = db.transaction("cache", "readonly").objectStore("cache").get(cle);
          tx.onsuccess = () => res(tx.result || null);
          tx.onerror = () => res(null);
        }),
        set: (cle, valeur) => new Promise((res) => {
          const tx = db.transaction("cache", "readwrite").objectStore("cache").put(valeur, cle);
          tx.onsuccess = () => res();
          tx.onerror = () => res();
        })
      });
    };
    requete.onerror = () => reject(requete.error);
  });
}

let correcteurPromise = null;
async function obtenirCorrecteur() {
  if (!correcteurPromise) {
    correcteurPromise = (async () => {
      const cache = await ouvrirCache();
      let aff = await cache.get("aff");
      let dic = await cache.get("dic");

      if (!aff || !dic) {
        const [reponseAff, reponseDic] = await Promise.all([
          fetch("https://cdn.jsdelivr.net/npm/dictionary-fr@2/index.aff"),
          fetch("https://cdn.jsdelivr.net/npm/dictionary-fr@2/index.dic")
        ]);
        aff = await reponseAff.text();
        dic = await reponseDic.text();
        await cache.set("aff", aff);
        await cache.set("dic", dic);
      }
      return nspell(aff, dic);
    })();
  }
  return correcteurPromise;
}

// ----------------------------------------------------------------------
// ÉTAPE 1 — Normalisation
// ----------------------------------------------------------------------
function normaliserEspaces(texte) {
  return texte
    .replace(/\r\n/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ----------------------------------------------------------------------
// ÉTAPE 2 — Segmentation en phrases (mini-automate à états)
// ----------------------------------------------------------------------
const ABREVIATIONS = new Set(["m.","mme.","mlle.","dr.","pr.","ex.","etc.","art.","vol.","p.","cf.","n°","min.","max."]);

function segmenterPhrases(texte) {
  const phrases = [];
  let courant = "";

  for (let i = 0; i < texte.length; i++) {
    const c = texte[i];
    courant += c;

    if (c === "." || c === "!" || c === "?" || c === "…") {
      const avant = texte[i - 1];
      const apres = texte[i + 1];
      const estDecimal = c === "." && avant >= "0" && avant <= "9" && apres >= "0" && apres <= "9";
      const motAvant = (courant.trim().split(/\s+/).pop() || "").toLowerCase();
      const estAbreviation = ABREVIATIONS.has(motAvant);
      const suiteDePoints = c === "." && apres === ".";

      if (!estDecimal && !estAbreviation && !suiteDePoints) {
        phrases.push(courant.trim());
        courant = "";
      }
    }
  }
  if (courant.trim()) phrases.push(courant.trim());
  return phrases;
}

// ----------------------------------------------------------------------
// ÉTAPE 3 — Correction typographique française
// ----------------------------------------------------------------------
function corrigerPonctuation(texte) {
  let t = texte;
  t = t.replace(/\s*([,.])/g, "$1");
  t = t.replace(/\s*([;:!?])/g, "\u00A0$1");
  t = t.replace(/([,.;:!?])(?=\S)/g, "$1 ");
  t = t.replace(/«\s*/g, "« ").replace(/\s*»/g, " »");
  return t.replace(/[ \u00A0]{2,}/g, " ").trim();
}

// ----------------------------------------------------------------------
// ÉTAPE 4 — Structuration (heuristiques de motifs)
// ----------------------------------------------------------------------
function structurerParagraphes(texte) {
  const blocs = texte.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  return blocs.map((bloc) => {
    const lignes = bloc.split("\n").map((l) => l.trim()).filter(Boolean);
    const estListe = lignes.length > 0 && lignes.every((l) => /^([-*•]|\d+[.)])\s+/.test(l));
    if (estListe) return { type: "liste", elements: lignes.map((l) => l.replace(/^([-*•]|\d+[.)])\s+/, "")) };
    const estTitre = lignes.length === 1 && lignes[0].length < 80 &&
      (lignes[0] === lignes[0].toUpperCase() || /^[A-ZÀ-Ý][^.!?]*$/.test(lignes[0]));
    if (estTitre) return { type: "titre", texte: lignes[0] };
    return { type: "paragraphe", texte: lignes.join(" ") };
  });
}

function rendreStructure(blocs) {
  return blocs.map((b) => {
    if (b.type === "titre") return "## " + b.texte;
    if (b.type === "liste") return b.elements.map((e) => "- " + e).join("\n");
    return b.texte;
  }).join("\n\n");
}

// ----------------------------------------------------------------------
// ÉTAPE 5 — Suggestions orthographiques (nspell, vrai dictionnaire français)
// ----------------------------------------------------------------------
async function suggererCorrections(texte) {
  const correcteur = await obtenirCorrecteur();
  const mots = Array.from(new Set(texte.match(/[a-zàâçéèêëîïôûùüÿñæœA-ZÀ-ÝÂÇÉÈÊËÎÏÔÛÙÜŸÑÆŒ']+/g) || []));
  const suggestions = [];

  for (const mot of mots) {
    if (mot.length < 3) continue;
    if (correcteur.correct(mot)) continue; // mot reconnu par le vrai dictionnaire : rien à signaler
    const propositions = correcteur.suggest(mot);
    if (propositions.length > 0) {
      suggestions.push({ mot, suggestion: propositions[0] });
    }
  }
  return suggestions.slice(0, 20);
}

// ----------------------------------------------------------------------
// PIPELINE COMPLET
// ----------------------------------------------------------------------
async function traiterPipeline(texteBrut, rapporterProgres) {
  rapporterProgres("normalisation");
  const normalise = normaliserEspaces(texteBrut);

  rapporterProgres("segmentation");
  const phrases = segmenterPhrases(normalise);

  rapporterProgres("structuration");
  const blocs = structurerParagraphes(normalise);
  const texteStructure = rendreStructure(blocs);

  rapporterProgres("chargement du dictionnaire et vérification orthographique");
  const suggestions = await suggererCorrections(normalise);

  return {
    texteStructure,
    nbPhrases: phrases.length,
    nbBlocs: blocs.length,
    suggestions
  };
}

self.addEventListener("message", async (evenement) => {
  const { texte, id } = evenement.data;
  try {
    const resultat = await traiterPipeline(texte, (etape) => {
      self.postMessage({ type: "PROGRES", id, etape });
    });
    self.postMessage({ type: "RESULTAT", id, resultat });
  } catch (erreur) {
    self.postMessage({ type: "ERREUR", id, message: erreur.message });
  }
});
