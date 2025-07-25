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

export function ageAtEpisode(episode_date, date_of_birth, manufacturer = "biotronik") {
    // Fonction pour convertir une date en format français en objet Date

    if(manufacturer === "medtronic") {
        episode_date = episode_date.replaceAll('-', ' ');
        date_of_birth = date_of_birth.replaceAll('-', ' ');
    }

    console.log("dates after treatement: ", episode_date, date_of_birth);

    function parseFrenchDate(dateStr, defaultTime = "00:00") {
        const months = {
            "janv.": "Jan",
            "févr.": "Feb",
            "mars": "Mar",
            "avr.": "Apr",
            "mai": "May",
            "juin": "Jun",
            "juil.": "Jul",
            "août": "Aug",
            "sept.": "Sep",
            "oct.": "Oct",
            "nov.": "Nov",
            "déc.": "Dec"
        };

        const parts = dateStr.split(' ');
        const day = parts[0];
        let month= "";
        if(months[parts[1]] === undefined) {
            console.log(`Month "${parts[1]}" is not recognized. Using default value`);
            month = parts[1];
        }else {
            month = months[parts[1]];
        }
        const year = parts[2];
        const time = parts[3] || defaultTime;

        console.log(`Parsing date: ${dateStr} -> ${day} ${month} ${year} ${time}`);
        return new Date(`${day} ${month} ${year} ${time}`);
    }

    // Convertir les dates (chaîne de caractères) en objets Date
    const episodeDateObj = parseFrenchDate(episode_date);
    const birthDateObj = parseFrenchDate(date_of_birth);

    console.log(`Episode date object: ${episodeDateObj}`);
    console.log(`Birth date object: ${birthDateObj}`);

    // Convertir les objets Date en secondes depuis l'époque (epoch)
    const episodeDateInSeconds = Math.floor(episodeDateObj.getTime() / 1000);
    const birthDateInSeconds = Math.floor(birthDateObj.getTime() / 1000);

    console.log(`Episode date in seconds: ${episodeDateInSeconds}`);
    console.log(`Birth date in seconds: ${birthDateInSeconds}`);

    // Vérifier si les dates sont valides
    if (isNaN(episodeDateInSeconds) || isNaN(birthDateInSeconds)) {
        console.error("Invalid date(s) provided.");
        return null;
    }

    // Calculer l'âge en secondes
    const ageInSeconds = episodeDateInSeconds - birthDateInSeconds;

    console.log("Age at episode in seconds: ", ageInSeconds);
    return ageInSeconds;
}