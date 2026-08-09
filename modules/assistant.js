// Fichier : assistant.js
// Ce script analyse la phrase de l'utilisateur et déduit quel module ouvrir.

class AssistantInterface {
    constructor() {
        // On liste ici les mots-clés qui déclenchent vos services (basé sur votre capture GitHub)
        this.services = [
            {
                nom: "generateur-mot-de-passe.html",
                motsCles: ["mot de passe", "mdp", "sécurité", "générer un code"]
            },
            {
                nom: "convertisseur.html",
                motsCles: ["convertir", "convertisseur", "conversion", "unité"]
            },
            {
                nom: "tirage-aleatoire.html",
                motsCles: ["hasard", "tirage", "aléatoire", "dé", "sort"]
            },
            {
                nom: "calculatrice.html",
                motsCles: ["calcul", "calculatrice", "addition", "math"]
            },
            {
                nom: "resume-texte.html",
                motsCles: ["résumé", "résumer", "synthèse", "texte court"]
            }
        ];
    }

    analyserPhrase(phrase) {
        // On met la phrase en minuscules pour faciliter la recherche
        const texte = phrase.toLowerCase();

        // On parcourt nos services pour voir si un mot-clé correspond à la phrase
        for (let service of this.services) {
            for (let mot of service.motsCles) {
                if (texte.includes(mot)) {
                    console.log(`💡 Intention trouvée : L'utilisateur veut le service ${service.nom}`);
                    return service.nom; // On retourne le nom du fichier HTML à charger
                }
            }
        }

        // Si aucun mot-clé n'est trouvé
        console.log("❌ Aucun service correspondant trouvé.");
        return null;
    }
}

// --- COMMENT L'UTILISER DANS VOTRE INTERFACE MÈRE ---
// 1. Instancier l'assistant : const assistant = new AssistantInterface();
// 2. Analyser le texte : const moduleACharger = assistant.analyserPhrase("Je veux créer un mot de passe fort");
// 3. moduleACharger contiendra "generateur-mot-de-passe.html". 
// 4. Vous passez ce résultat à votre routeur pour l'afficher !
