/**
 * ==========================================================================
 *  CORRECTEUR-TEXTE-WORKER.JS — Pipeline de traitement textuel déterministe
 * ==========================================================================
 *  Aucun LLM, aucun apprentissage statistique. Uniquement : RegEx, un
 *  automate à états simple pour la segmentation, des heuristiques de
 *  motifs pour la structuration, et la distance de Levenshtein pour les
 *  suggestions orthographiques. Tourne dans un Web Worker pour ne jamais
 *  bloquer le thread principal, même sur un texte volumineux.
 * ==========================================================================
 */

// ----------------------------------------------------------------------
// Dictionnaire compact de démonstration (français courant). Un vrai
// correcteur orthographique complet demanderait un dictionnaire Hunspell
// (ex: via nspell) — hors scope ici, signalé honnêtement plus bas.
// ----------------------------------------------------------------------
const DICTIONNAIRE_COMPACT = new Set([
  "le","la","les","un","une","des","de","du","et","est","en","à","au","aux",
  "ce","ces","cette","que","qui","dans","pour","par","sur","avec","sans",
  "être","avoir","faire","dire","aller","voir","savoir","pouvoir","vouloir",
  "bonjour","merci","recherche","texte","phrase","paragraphe","mot","ligne",
  "document","information","exemple","résultat","système","service","module",
  "français","langue","correction","orthographe","grammaire","ponctuation",
  "espace","structure","analyse","fonction","donnée","données","projet"
]);

// ----------------------------------------------------------------------
// ÉTAPE 1 — Normalisation
// ----------------------------------------------------------------------
function normaliserEspaces(texte) {
  return texte
    .replace(/\r\n/g, "\n")
    .replace(/\u00A0/g, " ")               // espace insécable -> espace normal
    .replace(/[\u200B-\u200D\uFEFF]/g, "") // caractères invisibles
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ----------------------------------------------------------------------
// ÉTAPE 2 — Segmentation en phrases (mini-automate à états)
//   État "normal" -> bascule sur un point/! /? UNIQUEMENT si ce qui suit
//   n'est pas un motif d'abréviation ou un nombre décimal connu.
// ----------------------------------------------------------------------
const ABREVIATIONS = new Set(["m.","mme.","mlle.","dr.","pr.","ex.","etc.","art.","vol.","p.","cf.","n°","min.","max."]);

function segmenterPhrases(texte) {
  const phrases = [];
  let courant = "";

  for (let i = 0; i < texte.length; i++) {
    const c = texte[i];
    courant += c;

    if (c === "." || c === "!" || c === "?" || c === "…") {
      // Nombre décimal (ex: "3.14") : ne pas couper
      const avant = texte[i - 1];
      const apres = texte[i + 1];
      const estDecimal = c === "." && avant >= "0" && avant <= "9" && apres >= "0" && apres <= "9";

      // Abréviation connue : ne pas couper
      const motAvant = (courant.trim().split(/\s+/).pop() || "").toLowerCase();
      const estAbreviation = ABREVIATIONS.has(motAvant);

      // Points de suspension "..." : attendre la fin de la séquence
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
// ÉTAPE 3 — Correction typographique française (espacement)
// ----------------------------------------------------------------------
function corrigerPonctuation(texte) {
  let t = texte;
  t = t.replace(/\s*([,.])/g, "$1");           // pas d'espace avant , .
  t = t.replace(/\s*([;:!?])/g, "\u00A0$1");   // espace insécable avant ; : ! ?
  t = t.replace(/([,.;:!?])(?=\S)/g, "$1 ");   // espace après ponctuation si collée
  t = t.replace(/«\s*/g, "« ").replace(/\s*»/g, " »");
  return t.replace(/[ \u00A0]{2,}/g, " ").trim();
}

// ----------------------------------------------------------------------
// ÉTAPE 4 — Structuration (heuristiques de motifs, pas de compréhension)
// ----------------------------------------------------------------------
function structurerParagraphes(texte) {
  const blocs = texte.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);

  return blocs.map((bloc) => {
    const lignes = bloc.split("\n").map((l) => l.trim()).filter(Boolean);

    const estListe = lignes.length > 0 && lignes.every((l) => /^([-*•]|\d+[.)])\s+/.test(l));
    if (estListe) {
      return { type: "liste", elements: lignes.map((l) => l.replace(/^([-*•]|\d+[.)])\s+/, "")) };
    }

    const estTitre = lignes.length === 1 && lignes[0].length < 80 &&
      (lignes[0] === lignes[0].toUpperCase() || /^[A-ZÀ-Ý][^.!?]*$/.test(lignes[0]));
    if (estTitre) {
      return { type: "titre", texte: lignes[0] };
    }

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
// ÉTAPE 5 — Suggestions orthographiques (Levenshtein, dictionnaire compact)
// ----------------------------------------------------------------------
function distanceLevenshtein(a, b) {
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

function suggererCorrections(texte) {
  const mots = Array.from(new Set((texte.toLowerCase().match(/[a-zàâçéèêëîïôûùüÿñæœ]+/g) || [])));
  const suggestions = [];

  for (const mot of mots) {
    if (mot.length < 3 || DICTIONNAIRE_COMPACT.has(mot)) continue;
    let meilleur = null, meilleureDistance = Infinity;
    for (const ref of DICTIONNAIRE_COMPACT) {
      if (Math.abs(ref.length - mot.length) > 2) continue;
      const dist = distanceLevenshtein(mot, ref);
      if (dist < meilleureDistance) { meilleureDistance = dist; meilleur = ref; }
    }
    if (meilleur && meilleureDistance <= 2) {
      suggestions.push({ mot, suggestion: meilleur, distance: meilleureDistance });
    }
  }
  return suggestions;
}

// ----------------------------------------------------------------------
// PIPELINE COMPLET — traitement par lots de paragraphes, avec progression
// ----------------------------------------------------------------------
async function traiterPipeline(texteBrut, rapporterProgres) {
  rapporterProgres("normalisation");
  const normalise = normaliserEspaces(texteBrut);

  rapporterProgres("segmentation");
  const phrases = segmenterPhrases(normalise);

  rapporterProgres("ponctuation");
  const texteRecompose = phrases.map(corrigerPonctuation).join(" ");

  rapporterProgres("structuration");
  const blocs = structurerParagraphes(normalise); // structuration sur la version normalisée (paragraphes d'origine)
  const texteStructure = rendreStructure(blocs);

  rapporterProgres("suggestions orthographiques");
  const suggestions = suggererCorrections(normalise);

  return {
    texteStructure,
    nbPhrases: phrases.length,
    nbBlocs: blocs.length,
    suggestions: suggestions.slice(0, 20) // limite raisonnable d'affichage
  };
}

// ----------------------------------------------------------------------
// Interface du Worker
// ----------------------------------------------------------------------
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
