from fastapi import FastAPI, WebSocket, Request, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware
import json
import logging

# Configuration du logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

app = FastAPI()

# --- Configuration CORS (IMPORTANT pour le développement local) ---
# Autorise les requêtes de ton frontend (localhost:8000 si tu es sur le même port)
# Ici, nous autorisons toutes les origines (*) pour la simplicité en DEV.
# En PROD, tu devrais lister explicitement tes domaines frontend.
origins = [
    "http://localhost",
    "http://127.0.0.1",
    "http://localhost:8000", # Assure-toi que c'est le port de ton frontend
    "http://127.0.0.1:8000",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"], # Autorise toutes les méthodes (GET, POST, etc.)
    allow_headers=["*"], # Autorise tous les en-têtes
)

# --- Configuration des fichiers statiques ---
app.mount("/static", StaticFiles(directory="static"), name="static")

# --- Configuration des templates HTML ---
templates = Jinja2Templates(directory="templates")

# --- Stockage des connexions WebSocket des utilisateurs ---
# Un dictionnaire pour mapper les noms d'utilisateurs à leurs objets WebSocket
connected_users: dict[str, WebSocket] = {}

# --- Route pour servir la page HTML du frontend ---
@app.get("/", response_class=HTMLResponse)
async def get_index(request: Request):
    logger.info("Serving index.html")
    return templates.TemplateResponse("index.html", {"request": request})

# --- Route WebSocket pour la signalisation WebRTC ---
@app.websocket("/ws/{username}")
async def websocket_endpoint(websocket: WebSocket, username: str):
    await websocket.accept()
    logger.info(f"WebSocket connecté: {username}")
    
    if username in connected_users:
        # Gérer le cas où l'utilisateur est déjà connecté (ex: déconnecter l'ancienne session)
        # Pour cet exemple simple, nous allons juste refuser la nouvelle connexion.
        await websocket.send_json({"type": "error", "message": "Nom d'utilisateur déjà pris."})
        await websocket.close(code=1008) # Code d'erreur "Policy Violation"
        logger.warning(f"Connexion refusée pour {username}, déjà connecté.")
        return

    connected_users[username] = websocket

    try:
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            message_type = message.get("type")
            target_user = message.get("target_user")
            sender_username = message.get("from", username) # Qui envoie le message

            logger.info(f"Message de {sender_username} ({message_type}) vers {target_user}")

            if target_user and target_user in connected_users:
                target_websocket = connected_users[target_user]

                # Envoyer le message de signalisation au destinataire
                await target_websocket.send_json(message)
                logger.info(f"Message ({message_type}) relayé à {target_user}.")
            elif target_user:
                # L'utilisateur cible n'est pas connecté
                logger.warning(f"Utilisateur cible '{target_user}' non trouvé pour le message de {sender_username}.")
                await websocket.send_json({"type": "user_not_found", "target_user": target_user})
            else:
                logger.warning(f"Message de {sender_username} sans cible ou type invalide: {message}")
                await websocket.send_json({"type": "error", "message": "Message invalide."})

    except WebSocketDisconnect:
        logger.info(f"WebSocket déconnecté: {username}")
    except Exception as e:
        logger.error(f"Erreur WebSocket pour {username}: {e}")
    finally:
        # Supprimer l'utilisateur des connexions actives lors de la déconnexion
        if username in connected_users:
            del connected_users[username]
            logger.info(f"Utilisateur {username} retiré des connexions actives.")
            # Si un appel était en cours, informer l'autre partie
            for user, ws_conn in connected_users.items():
                if ws_conn == websocket: # Si le websocket déconnecté est l'expéditeur d'un appel
                    # Ceci est une logique simplifiée. Dans une vraie app, tu suivrais les paires d'appels.
                    pass 
                # Si l'utilisateur déconnecté était le "target_user" d'un appel en cours
                # il faudrait envoyer un message "call_end" à l'autre partie.