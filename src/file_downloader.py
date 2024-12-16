from pymongo import MongoClient
import gridfs
import os
import base64
import zipfile
import io

# Configuration de la connexion à MongoDB
client = MongoClient("mongodb://musicp.chu-bordeaux.fr:27017/")
db = client.grid_fs
fs = gridfs.GridFS(db)

# Utiliser un chemin absolu pour le répertoire de téléchargement
output_directory = os.path.abspath("./downloaded_files")

if not os.path.exists(output_directory):
    os.makedirs(output_directory)

# Fonction pour récupérer le file_id à partir de l'episodeNumber
def get_file_id_from_episode(episode_number):
    episode = db.infos_episodes.find_one({"episodeNumber": episode_number})
    if episode and episode['file_id']:
        return episode['file_id']
    else:
        print(f"Aucun file_id trouvé pour l'episodeNumber : {episode_number}")
        return None

# Fonction pour récupérer le filename à partir du file_id
def get_filename_from_file_id(file_id):
    file = db.fs.files.find_one({"_id": file_id})
    if file:
        return file['filename']
    else:
        print(f"Aucun fichier trouvé pour file_id : {file_id}")
        return None

# Fonction pour télécharger et sauvegarder le fichier de GridFS
def download_and_process_file(file_id, filename, output_directory):
    # Trouver les chunks associés
    chunks = db.fs.chunks.find({"files_id": file_id}).sort("n", 1)
    file_data = b''.join([chunk['data'] for chunk in chunks])

    try:
        if filename.endswith(".svg"):
            # Décoder les données Base64 pour les fichiers SVG
            raw_content = base64.b64decode(file_data)
            output_path = os.path.join(output_directory, filename)
            with open(output_path, "wb") as f:
                f.write(raw_content)
            print(f"Fichier SVG {filename} téléchargé, décodé et sauvegardé à {output_path}.")
        
        elif filename.endswith(".zip"):
            # Enregistrer directement le fichier ZIP sans décodage Base64
            output_path = os.path.join(output_directory, filename)
            with open(output_path, "wb") as f:
                f.write(file_data)
            print(f"Fichier ZIP {filename} téléchargé et sauvegardé à {output_path}.")

            # Extraire le contenu du fichier ZIP
            with zipfile.ZipFile(output_path, 'r') as zip_ref:
                zip_ref.extractall(output_directory)
            print(f"Fichiers extraits du ZIP {filename} dans le répertoire {output_directory}.")
        
        else:
            print(f"Type de fichier non supporté pour {filename}.")
            
    except Exception as e:
        print(f"Erreur lors du traitement du fichier {filename} : {e}")

if __name__ == "__main__":
    episode_number = input("Enter episode number: ")
    file_id = get_file_id_from_episode(episode_number)
    if file_id:
        filename = get_filename_from_file_id(file_id)
        if filename:
            download_and_process_file(file_id, filename, output_directory)
