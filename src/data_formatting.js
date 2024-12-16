export function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            // Extraire la partie base64 de la Data URL
            const base64data = reader.result.split(',')[1];
            resolve(base64data);
        };
        reader.onerror = () => {
            reject(new Error("Erreur lors de la conversion du blob en base64."));
        };
        reader.readAsDataURL(blob);
    });
}

export function formatAgeAtEpisode(episode_date, date_of_birth) {
    // Convertir les dates (chaîne de caractères) en objets Date
    const episodeDateObj = new Date(episode_date);
    const birthDateObj = new Date(date_of_birth);

    // Convertir les objets Date en secondes depuis l'époque (epoch)
    const episodeDateInSeconds = Math.floor(episodeDateObj.getTime() / 1000);
    const birthDateInSeconds = Math.floor(birthDateObj.getTime() / 1000);

    // Calculer l'âge en secondes
    const ageInSeconds = episodeDateInSeconds - birthDateInSeconds;

    // Convertir l'âge en années
    const ageAtEpisode = Math.floor(ageInSeconds / (60 * 60 * 24 * 365));
    return ageAtEpisode;
}